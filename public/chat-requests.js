// A request belongs to its conversation, independently of the visible page.
export function createChatRequests({api,onChange=()=>{}}) {
  let current=null;
  const valid=task=>current===task&&!task.controller.signal.aborted;
  async function run(task) {
    const options={signal:task.controller.signal};
    try {
      if(!task.id) {
        const result=await api('/api/conversations',{...options,method:'POST',body:{provider:task.provider}});
        if(!valid(task))return;
        task.id=result.conversation.id;task.conversation=result.conversation;
        onChange(task,'created');
      }
      const result=await api('/api/chat',{...options,method:'POST',body:{conversationId:task.id,message:task.message}});
      if(!valid(task))return;
      task.messages=result.messages;task.conversation=result.conversation;task.usage=result.usage;task.status='complete';
    } catch(error) {
      if(!valid(task))return;
      task.error=error.message;
      // A lost response can still have committed on the server. Reconcile the
      // original conversation, never whichever page is now visible.
      if(task.id)try {const result=await api(`/api/conversations/${encodeURIComponent(task.id)}`,options);if(valid(task))task.messages=result.messages;}catch { /* Retain the previously committed messages. */ }
      try {const session=await api('/api/session',options);if(valid(task))task.usage=session.usage;}catch { /* Keep the original error. */ }
      if(!valid(task))return;
      task.status='error';
    }
    if(valid(task))onChange(task,'settled');
  }
  return {
    get current(){return current;},
    get pending(){return current?.status==='pending'?current:null;},
    start({provider,conversationId=null,message,messages=[],originGeneration}) {
      if(current?.status==='pending')throw new Error('已有对话正在生成回复');
      const task={provider,id:conversationId,message,messages:[...messages],originGeneration,status:'pending',controller:new AbortController(),createdAt:new Date().toISOString()};
      current=task;onChange(task,'started');task.done=run(task);return task;
    },
    clear(){current?.controller.abort();current=null;}
  };
}
