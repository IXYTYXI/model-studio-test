import {activatePopup} from './select-control.js';
const controls=new Set();
export function disposeModelControls(){for(const control of controls)control.destroy();controls.clear();}
const node=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls;if(text!==undefined)n.textContent=text;return n;};

export function modelControl({input,load,onLoaded,onReset}) {
  const root=node('div','model-control'),row=node('div','model-input-row');
  const toggle=node('button','model-toggle','⌄');toggle.type='button';toggle.setAttribute('aria-label','展开模型列表');toggle.disabled=true;
  const fetchButton=node('button','secondary-button model-fetch','获取模型');fetchButton.type='button';
  const status=node('p','field-hint model-status','填写地址和 Key 后获取模型，也可直接输入模型 ID。');status.id=input.id+'-status';status.setAttribute('role','status');
  input.placeholder='获取模型后搜索，或手动填写模型 ID';input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-haspopup','listbox');input.setAttribute('aria-expanded','false');input.setAttribute('aria-describedby',status.id);
  row.append(input,toggle,fetchButton);root.append(row,status);
  let models=[],menu,filtered=[],active=-1,events,release,request,sequence=0;
  const message=(text,error=false)=>{status.textContent=text;status.classList.toggle('error',error);};
  function close(){if(!menu)return;events.abort();menu.remove();menu=null;release?.();input.setAttribute('aria-expanded','false');input.removeAttribute('aria-controls');input.removeAttribute('aria-activedescendant');}
  function position(){
    const rect=input.getBoundingClientRect(),viewport=window.visualViewport;
    const left=viewport?.offsetLeft||0,top=viewport?.offsetTop||0,width=viewport?.width||innerWidth,height=viewport?.height||innerHeight;
    const panel=root.closest('.settings-content')?.getBoundingClientRect();
    const minY=Math.max(top+12,panel?.top||0),maxY=Math.min(top+height-12,panel?.bottom||top+height-12);
    const below=maxY-rect.bottom-6,above=rect.top-minY-6,up=below<Math.min(menu.scrollHeight,270)&&above>below;
    menu.style.width=`${Math.min(row.clientWidth,width-24)}px`;menu.style.maxHeight=`${Math.max(44,Math.min(270,up?above:below))}px`;
    menu.style.left=`${Math.max(left+12,Math.min(rect.left,left+width-menu.offsetWidth-12))}px`;
    menu.style.top=`${up?rect.top-menu.offsetHeight-6:rect.bottom+6}px`;
  }
  function highlight(index){
    active=index;const items=[...menu.querySelectorAll('[role=option]')];items.forEach((item,i)=>item.classList.toggle('highlighted',i===active));
    if(items[active]){input.setAttribute('aria-activedescendant',items[active].id);items[active].scrollIntoView({block:'nearest'});}else input.removeAttribute('aria-activedescendant');
  }
  function choose(index){if(!filtered[index])return;input.value=filtered[index].id;close();input.focus({preventScroll:true});input.dispatchEvent(new Event('change',{bubbles:true}));message('已选择模型，点击保存后生效。');}
  function render(all){
    const search=all?'':input.value.trim().toLowerCase();filtered=models.filter(m=>(m.id+' '+m.name).toLowerCase().includes(search));
    menu.replaceChildren();
    if(!filtered.length)menu.append(node('div','model-empty','没有匹配模型，可继续手动输入。'));
    for(const [index,m] of filtered.entries()){
      const item=node('div','select-option model-option');item.id=input.id+'-model-'+index;item.setAttribute('role','option');item.setAttribute('aria-selected',String(m.id===input.value));
      const label=node('div','model-option-label');label.append(node('span','',m.id));if(m.name!==m.id)label.append(node('small','',m.name));
      if(Number.isSafeInteger(m.maxOutputTokens)&&m.maxOutputTokens>0)label.append(node('small','','最大输出 '+m.maxOutputTokens.toLocaleString()+' Token'));
      item.append(label,node('span','select-check','✓'));item.lastChild.setAttribute('aria-hidden','true');
      item.addEventListener('pointerdown',event=>event.preventDefault());item.addEventListener('click',()=>choose(index));item.addEventListener('pointermove',()=>highlight(index));menu.append(item);
    }
    active=filtered.findIndex(m=>m.id===input.value);position();highlight(active);
  }
  function open(all=true){
    if(!models.length||input.disabled||!root.isConnected)return;
    if(menu){render(all);return;}
    release=activatePopup(close);menu=node('div','select-menu model-menu');menu.id=input.id+'-models';menu.setAttribute('role','listbox');menu.setAttribute('aria-label','可用模型');
    (root.closest('dialog')||document.body).append(menu);input.setAttribute('aria-expanded','true');input.setAttribute('aria-controls',menu.id);
    events=new AbortController();const opts={signal:events.signal};
    document.addEventListener('pointerdown',event=>{if(!root.contains(event.target)&&!menu.contains(event.target))close();},opts);
    document.addEventListener('scroll',event=>{if(!menu.contains(event.target))close();},{...opts,capture:true});
    window.addEventListener('resize',close,opts);window.visualViewport?.addEventListener('resize',close,opts);
    root.closest('dialog')?.addEventListener('close',close,opts);render(all);
  }
  function cancel(){sequence++;request?.abort();request=null;fetchButton.textContent='获取模型';root.removeAttribute('aria-busy');}
  function reset(){cancel();close();models=[];onReset?.();toggle.disabled=true;message('连接信息已更改，请重新获取模型；也可手动填写。');}
  input.addEventListener('input',()=>open(false));input.addEventListener('click',()=>open());input.addEventListener('blur',close);
  toggle.addEventListener('click',()=>{input.focus({preventScroll:true});menu?close():open();});toggle.addEventListener('pointerdown',event=>event.preventDefault());
  input.addEventListener('keydown',event=>{
    if(event.isComposing)return;
    if(event.key==='Escape'&&menu){event.preventDefault();event.stopPropagation();close();return;}
    if(event.key==='Tab'){close();return;}
    if(['ArrowDown','ArrowUp'].includes(event.key)){
      event.preventDefault();if(!menu)open();if(!menu||!filtered.length)return;
      highlight(event.key==='ArrowDown'?(active+1)%filtered.length:(active<=0?filtered.length-1:active-1));return;
    }
    if(event.key==='Enter'&&menu){event.preventDefault();if(active>=0)choose(active);else close();}
  });
  fetchButton.addEventListener('click',async()=>{
    if(request){cancel();message('已取消获取，可重试或手动填写。');return;}
    close();models=[];onReset?.();toggle.disabled=true;const ticket=++sequence;request=new AbortController();const signal=request.signal;
    root.setAttribute('aria-busy','true');fetchButton.textContent='取消获取';message('正在获取模型…');
    try {
      const result=await load(signal);
      if(ticket!==sequence||signal.aborted||!root.isConnected)return;
      models=result.models;onLoaded?.(result);toggle.disabled=!models.length;
      message(models.length?`获取到 ${models.length} 个模型${result.truncated?'（列表已截断）':''}。输入名称搜索，选择后保存；可调用性以实际请求为准。`:'服务商返回的模型列表为空，可手动填写模型 ID。');
      if(models.length){input.focus({preventScroll:true});input.scrollIntoView({block:'nearest'});open();}
    } catch(error){if(ticket===sequence&&!signal.aborted&&root.isConnected)message(error.message,true);}
    finally{if(ticket===sequence){request=null;fetchButton.textContent='获取模型';root.removeAttribute('aria-busy');}}
  });
  const control={root,input,reset,cancel,saved(){close();message('模型设置已保存，可重新获取列表或更换模型。');},destroy(){cancel();close();controls.delete(control);}};controls.add(control);return control;
}
