import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinimalAgentRuntime, type AgentEvent } from "../src";
import { FakeModel } from "@harness/models";
import { LocalWorkspace } from "@harness/workspace";
import { createDevelopmentTools, DEVELOPMENT_TOOL_NAMES } from "@harness/tools";

it("M11: five tools edit only the allowed fixture, test it and return a bounded diff with typed failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "m11-"));
  try {
    writeFileSync(join(root,"fixture.txt"),"old");
    writeFileSync(join(root,"protected.txt"),"protected");
    const argv: [string,...string[]] = [process.execPath,"-e","if(require('node:fs').readFileSync('fixture.txt','utf8')!=='new') process.exit(1)"];
    const workspace = new LocalWorkspace({root,developerOnly:true,allowedPaths:["fixture.txt"],commands:[argv]});
    const calls = [
      ["fs.list",{path:"."}], ["fs.read",{path:"fixture.txt"}],
      ["fs.write",{path:"../outside",contents:"bad"}],
      ["fs.write",{path:"protected.txt",contents:"bad"}],
      ["fs.write",{path:"fixture.txt",contents:"new",extra:true}],
      ["fs.write",{path:"fixture.txt",contents:"new"}],
      ["process.exec",{argv:["sh","-c","touch bad"]}],
      ["process.exec",{argv}], ["git.diff",{}],
    ] as const;
    const model = new FakeModel([...calls.map(([name,args],i)=>({toolCalls:[{id:`c${i}`,name,arguments:JSON.parse(JSON.stringify(args))}]})),{content:"done"}]);
    const events: AgentEvent[] = [];
    const store = {async append(e:AgentEvent){events.push(e)},async *readSession(){yield* events}};
    for await (const _ of new MinimalAgentRuntime().run({runId:"m11",sessionId:"s",turnId:"t",input:"edit fixture",model:"fake",modelAdapter:model,eventStore:store,workspace,tools:createDevelopmentTools(root),budget:{maxSteps:12},permission:{decide:()=>({effect:"allow",reason:"fixture"})}})) { /* drain */ }
    expect(model.requests[0]!.tools!.map(t=>t.name)).toEqual(DEVELOPMENT_TOOL_NAMES);
    expect(readFileSync(join(root,"fixture.txt"),"utf8")).toBe("new");
    expect(readFileSync(join(root,"protected.txt"),"utf8")).toBe("protected");
    const results = events.filter(e=>e.type==="tool.result");
    expect(results.filter(e=>!e.data.ok)).toHaveLength(4);
    expect(JSON.stringify(results)).toContain("WORKSPACE_SCOPE");
    expect(JSON.stringify(results)).toContain("+new");
    expect(events.filter(e=>e.type==="turn.completed")).toHaveLength(1);
    // Unsafe links are rejected before destination modification.
    symlinkSync(join(root,"protected.txt"),join(root,"link"));
    await expect(workspace.writeFile("fixture.txt","bad")).rejects.toMatchObject({code:"WORKSPACE_PATH"});
    rmSync(join(root,"link"));
    linkSync(join(root,"protected.txt"),join(root,"hard"));
    await expect(workspace.writeFile("fixture.txt","bad")).rejects.toMatchObject({code:"WORKSPACE_PATH"});
    expect(readFileSync(join(root,"fixture.txt"),"utf8")).toBe("new");
    await workspace.dispose();
  } finally {rmSync(root,{recursive:true,force:true})}
});
