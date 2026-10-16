// A request belongs to its conversation, independently of the visible page.
export function createChatRequests({api,onChange=()=>{}}) {
  const tasks=new Map();let sequence=0;
  const valid=task=>tasks.get(task.key)===task&&!task.controller.signal.aborted;
  const pendingFor=(provider,id,originGeneration)=>[...tasks.values()].find(task=>task.status==='pending'&&task.provider===provider&&(id?task.id===id:!task.id&&task.originGeneration===originGeneration))||null;
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
      if(!valid(task))return;
      try {const session=await api('/api/session',options);if(valid(task))task.usage=session.usage;}catch { /* Keep the original error. */ }
      if(!valid(task))return;
      task.status='error';
    }
    if(valid(task))onChange(task,'settled');
  }
  return {
    get tasks(){return [...tasks.values()];},
    get pending(){return [...tasks.values()].filter(task=>task.status==='pending');},
    pendingFor,
    forConversation(id){return [...tasks.values()].find(task=>task.id===id)||null;},
    acknowledge(task){if(task&&task.status!=='pending'){task.noticeSeen=true;tasks.delete(task.key);}},
    start({provider,conversationId=null,message,messages=[],originGeneration}) {
      if(pendingFor(provider,conversationId,originGeneration))throw new Error('此对话正在生成回复');
      for(const task of tasks.values())if(conversationId&&task.id===conversationId&&task.status!=='pending')tasks.delete(task.key);
      const task={key:++sequence,provider,id:conversationId,message,messages:[...messages],originGeneration,status:'pending',controller:new AbortController(),createdAt:new Date().toISOString()};
      tasks.set(task.key,task);onChange(task,'started');task.done=run(task);return task;
    },
    clear(){for(const task of tasks.values())task.controller.abort();tasks.clear();}
  };
}
