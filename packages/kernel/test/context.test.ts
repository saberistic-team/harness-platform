import {it,expect} from "vitest";
import {MinimalAgentRuntime, type AgentEvent, type RunInput, contextOccupancy} from "../src";
import {FakeModel, type ModelRequest} from "@harness/models";
function fixture(model:FakeModel, overrides:Partial<RunInput>={}) {
 const events:AgentEvent[]=[];
 const store={async append(e:AgentEvent){events.push(e)},async *readSession(){yield* events}};
 const input:RunInput={runId:"r",sessionId:"s",turnId:"t",input:"continue",model:"fake",modelAdapter:model,eventStore:store,
 context:Array.from({length:8},(_,i)=>({role:i%2?"assistant" as const:"user" as const,content:`original ${i} `+"x".repeat(400)})),
 contextPolicy:{windowTokens:6000,thresholdTokens:2000,tailMessages:2,reserveTokens:100},...overrides};
 return {events,store,input};
}
async function drain(stream:AsyncIterable<AgentEvent>){for await(const _ of stream){}}
it("M13 persists a versioned summary/tail, reconstructs the next request, and retains originals for follow-ups",async()=>{
 const model=new FakeModel([{content:"Earlier decisions",usage:{promptTokens:100,completionTokens:10,totalTokens:110}},{content:"done",usage:{promptTokens:20,completionTokens:3,totalTokens:23}}]);
 const {input,events,store}=fixture(model);const runtime=new MinimalAgentRuntime();
 await drain(runtime.run(input));
 const checkpoint=events.find(e=>e.type==="context.checkpoint")!;
 if(checkpoint.type!=="context.checkpoint")throw Error();
 expect(checkpoint.data.version).toBe(1);
 expect(model.requests[1]!.messages).toEqual([{role:"system",content:"Conversation summary (v1): Earlier decisions"},...checkpoint.data.tail]);
 expect((model.requests[1]! as ModelRequest).messageRevision).toBe(9);
 const terminal=events.find(e=>e.type==="turn.completed")!;
 expect(terminal.data).toMatchObject({usage:{totalTokens:133},messageRevision:10});
 expect(input.context![0]!.content).toContain("original 0");
 // Removing the compaction trigger retains the persisted summary view while
 // preserving the original revision rather than renumbering the conversation.
 const follow=new FakeModel([{content:"next"}]);
 await drain(runtime.run({...input,runId:"r2",turnId:"t2",context:undefined,input:"follow",modelAdapter:follow,eventStore:store,contextPolicy:undefined}));
 expect(follow.requests[0]!.messages[0]!.content).toContain("Earlier decisions");
 expect((follow.requests[0]! as ModelRequest).messageRevision).toBe(11);
});
it("M13 summary failure is typed and never commits a destructive checkpoint",async()=>{
 const {input,events}=fixture(new FakeModel([{content:"",finishReason:"error",usage:{promptTokens:8,completionTokens:1,totalTokens:9}}]));
 await expect(drain(new MinimalAgentRuntime().run(input))).rejects.toMatchObject({code:"RUNTIME_SUMMARY_FAILED"});
 expect(events.some(e=>e.type==="context.checkpoint")).toBe(false);
 expect(events.find(e=>e.type==="turn.completed")!.data).toMatchObject({status:"failed",usage:{totalTokens:9},messageRevision:9});
 expect(input.context).toHaveLength(8);
});
it("M13 summary usage reaches the hard budget before another model request",async()=>{
 const model=new FakeModel([{content:"summary",usage:{promptTokens:90,completionTokens:10,totalTokens:100}}]);
 const {input,events}=fixture(model,{budget:{maxModelTokens:100}});
 await expect(drain(new MinimalAgentRuntime().run(input))).rejects.toMatchObject({code:"RUNTIME_BUDGET_EXCEEDED"});
 expect(model.requests).toHaveLength(1);
 expect(events.some(e=>e.type==="budget.warning")).toBe(true);
});
it("M13 stops with typed overflow when the retained tail cannot fit and preserves original state",async()=>{
 const model=new FakeModel([{content:"summary"}]);
 const {input,events}=fixture(model,{context:[{role:"user",content:"a".repeat(500)},{role:"assistant",content:"b".repeat(500)},{role:"user",content:"t".repeat(2000)}],contextPolicy:{windowTokens:1800,thresholdTokens:1000,tailMessages:2,reserveTokens:100}});
 await expect(drain(new MinimalAgentRuntime().run(input))).rejects.toMatchObject({code:"RUNTIME_CONTEXT_OVERFLOW"});
 expect(events.filter(e=>e.type==="context.checkpoint")).toHaveLength(1);
 expect(events.find(e=>e.type==="turn.completed")!.data).toMatchObject({messageRevision:4,status:"failed"});
 expect(model.requests).toHaveLength(1);
 expect(contextOccupancy(model.requests[0]!.messages,[])).toBeLessThan(1800);
});
