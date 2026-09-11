import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinimalAgentRuntime, type AgentEvent, type Workspace } from "../src";
import { FakeModel } from "@harness/models";
import { LocalWorkspace, DockerWorkspace, bindWorkspace, restrictWorkspace, isIsolatedWorkspace } from "@harness/workspace";
import { createDevelopmentTools, DEVELOPMENT_TOOL_NAMES } from "@harness/tools";

const image = `node@sha256:${"a".repeat(64)}`;
async function run(model: FakeModel, workspace: Workspace, root: string) {
  const events: AgentEvent[] = [];
  const store = { async append(e: AgentEvent) { events.push(e); }, async *readSession() { yield* events; } };
  for await (const _ of new MinimalAgentRuntime().run({runId:"m11",sessionId:"s",turnId:"t",input:"edit fixture",model:"fake",modelAdapter:model,eventStore:store,workspace,tools:createDevelopmentTools(root),budget:{maxSteps:12},permission:{decide:()=>({effect:"allow",reason:"fixture"})}})) { /* drain */ }
  return events;
}

it("M11: isolated five-tool edit/test/diff and invalid attempts preserve the source tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "m11-"));
  let workspace: DockerWorkspace | undefined;
  let testsRun = 0;
  try {
    writeFileSync(join(root,"fixture.txt"),"old");
    writeFileSync(join(root,"protected.txt"),"protected");
    workspace = await DockerWorkspace.create({root,allowedPaths:["fixture.txt"],image,executor:{async execute(_program,args,options){
      const result = {exitCode:0,stdout:"",stderr:"",timedOut:false,aborted:false,outputTruncated:false};
      if(args[0]==="rm") return result;
      expect(args[0]).toBe("run");
      expect(args).not.toContain("--mount");
      options.onSpawn?.();
      writeFileSync(args[args.indexOf("--cidfile")+1]!,"a".repeat(64));
      const input = JSON.parse(options.input!);
      if(input.command.argv[0]==="fixture-tests") {
        testsRun++;
        expect(input.files["fixture.txt"]).toBe("new");
        expect(input.files["protected.txt"]).toBe("protected");
      } else expect(input.command.argv).toEqual(["node","-e","process.exit(0)"]);
      return {...result,stdout:JSON.stringify({version:1,files:input.files,result:{exitCode:0,stdout:"tests passed",stderr:"",timedOut:false}})};
    }}});
    const calls = [
      ["fs.list",{path:"."}], ["fs.read",{path:"fixture.txt"}],
      ["fs.write",{path:"../outside",contents:"bad"}],
      ["fs.write",{path:"protected.txt",contents:"bad"}],
      ["fs.write",{path:"fixture.txt",contents:"new",extra:true}],
      ["fs.write",{path:"fixture.txt",contents:"new"}],
      ["process.exec",{command:"touch bad"}],
      ["process.exec",{argv:["fixture-tests"]}], ["git.diff",{}],
    ] as const;
    const model = new FakeModel([...calls.map(([name,args],i)=>({toolCalls:[{id:`c${i}`,name,arguments:JSON.parse(JSON.stringify(args))}]})),{content:"done"}]);
    const events = await run(model,workspace,root);
    expect(model.requests[0]!.tools!.map(t=>t.name)).toEqual(DEVELOPMENT_TOOL_NAMES);
    expect(await workspace.readFile("fixture.txt")).toBe("new");
    expect(readFileSync(join(root,"fixture.txt"),"utf8")).toBe("old");
    expect(readFileSync(join(root,"protected.txt"),"utf8")).toBe("protected");
    expect(testsRun).toBe(1);
    const results=events.filter(e=>e.type==="tool.result");
    expect(results.filter(e=>!e.data.ok)).toHaveLength(4);
    expect(JSON.stringify(results)).toContain("WORKSPACE_SCOPE");
    expect(JSON.stringify(results)).toContain("+new");
    expect(events.filter(e=>e.type==="turn.completed")).toHaveLength(1);
    expect(isIsolatedWorkspace(restrictWorkspace(bindWorkspace(workspace),"writeFile"))).toBe(true);
    // Replacing an attested method revokes authority; a prototype/flag is insufficient.
    workspace.writeFile = async () => { throw Error("must not execute"); };
    expect(isIsolatedWorkspace(bindWorkspace(workspace))).toBe(false);
  } finally {await workspace?.dispose();rmSync(root,{recursive:true,force:true});}
});

it.each(["ordinary", "symlink", "hardlink", "parent-swap"])("M11 rejects local model mutations before effects, including %s substitution",async attack=>{
  const root=mkdtempSync(join(tmpdir(),"m11-local-"));
  try {
    mkdirSync(join(root,"allowed"));mkdirSync(join(root,"outside"));
    writeFileSync(join(root,"allowed/x"),"original");writeFileSync(join(root,"outside/x"),"victim");
    let processes=0;
    const local=new LocalWorkspace({root,developerOnly:true,allowedPaths:["allowed/**"],commands:[["fixture-tests"]],executor:{async execute(){processes++;throw Error("must not execute");}}});
    if(attack==="parent-swap") {renameSync(join(root,"allowed"),join(root,"saved"));symlinkSync(join(root,"outside"),join(root,"allowed"));}
    if(attack==="symlink"||attack==="hardlink") {
      rmSync(join(root,"allowed/x"));
      if(attack==="symlink")symlinkSync(join(root,"outside/x"),join(root,"allowed/x"));
      else linkSync(join(root,"outside/x"),join(root,"allowed/x"));
    }
    const model=new FakeModel([{toolCalls:[{id:"w",name:"fs.write",arguments:{path:"allowed/x",contents:"bad"}},{id:"e",name:"process.exec",arguments:{argv:["fixture-tests"]}}]},{content:"done"}]);
    const events=await run(model,local,root);
    expect(events.filter(e=>e.type==="tool.result").map(e=>e.data.error?.code)).toEqual(["WORKSPACE_ISOLATION_REQUIRED","WORKSPACE_ISOLATION_REQUIRED"]);
    expect(readFileSync(join(root,"outside/x"),"utf8")).toBe("victim");
    if(attack==="ordinary")expect(readFileSync(join(root,"allowed/x"),"utf8")).toBe("original");
    expect(processes).toBe(0);
    await local.dispose();
  } finally {rmSync(root,{recursive:true,force:true});}
});
