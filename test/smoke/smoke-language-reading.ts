import type { SmokeAppWindow } from './smoke-kit.ts'
import { run } from './smoke-kit.ts'

/** Actual DOM regression: locale changes retain reader-expanded answers and a task's live draft. */
export async function checkReadingLanguage(win: SmokeAppWindow): Promise<string[]> {
  return await run(win, `(async()=>{
    const {setLocale,getLocale}=await import('../shared/i18n/locale.js');
    const {t}=await import('../shared/i18n/translate.js');
    const {initialState,reduce}=await import('./state.js');
    const {renderThread}=await import('./view/thread.js');
    const {renderTasksPage}=await import('./view/tasks-page.js');
    const previousLocale=getLocale(),failures=[];
    const host=document.createElement('div');host.style.cssText='position:fixed;inset:80px 20px 20px;background:var(--bg);z-index:99999;overflow:auto';document.body.append(host);
    const thread=document.createElement('div');thread.className='thread';host.append(thread);
    const fence=String.fromCharCode(96).repeat(3);
    const text=Array.from({length:507},(_,i)=>'## Section '+i+'\\n\\nStable source text 中文 emoji 😀 '+i+'\\n\\n|A|B|\\n|-|-|\\n|1|2|\\n\\n'+fence+'ts\\nconst value = '+i+'\\n'+fence).join('\\n\\n')+'\\n\\n- [x] Done\\n- [ ] Open\\n\\n![diagram](https://example.invalid/image.png)';
    const handlers=new Proxy({openLink(){}},{get:(target,key)=>Reflect.get(target,key)??(()=>{})});
    const check=(value,message)=>{if(!value)failures.push(message)};
    try{
      setLocale('zh-CN');
      const state={...initialState,messages:[{id:'reading-answer',role:'assistant',text,shown:text.length}],conversationId:'reading-fixture'};
      renderThread(thread,state,handlers);thread.querySelector('.answer-more').click();
      const markdown=thread.querySelector('.markdown'),heading=markdown.querySelector('h3'),code=markdown.querySelector('pre'),image=markdown.querySelector('[data-md-image-label]');
      const range=document.createRange();range.selectNodeContents(markdown.querySelector('p'));const selection=getSelection();selection.removeAllRanges();selection.addRange(range);const selected=selection.toString();
      for(const locale of ['en','zh-CN','en']){
        setLocale(locale);renderThread(thread,state,handlers);
        check(thread.querySelector('.markdown')===markdown,'Reading: Markdown node replaced in '+locale);
        check(heading.isConnected&&code.isConnected,'Reading: source nodes detached in '+locale);
        check(markdown.querySelectorAll('h3').length===507&&!markdown.querySelector('.answer-more'),'Reading: expanded answer collapsed in '+locale);
        check(selection.toString()===selected,'Reading: text selection lost in '+locale);
        check(image.textContent===t('files-panel.image',{value1:'diagram'}),'Reading: image label kept stale language in '+locale);
        check(markdown.querySelector('input[checked]').getAttribute('aria-label')===t('island-view.completed'),'Reading: checkbox kept stale language in '+locale);
      }
      selection.removeAllRanges();
      setLocale('zh-CN');
      const page=document.createElement('div');page.className='tasks-page';page.style.cssText='display:flex;height:400px;width:900px';host.append(page);
      let stateTask=reduce(initialState,{type:'task_started',task:{id:'reading-task',title:'Task fixture',segmentId:'reading-segment'},text:'Fixture request',at:1});
      const task=stateTask.tasks.list[0];stateTask={...stateTask,tasks:{...stateTask.tasks,list:[{...task,view:{...task.view,messages:[...task.view.messages,{id:'task-answer',role:'assistant',text,shown:text.length}]}}],page:{open:true,selected:task.id,steps:false}}};
      renderTasksPage(page,stateTask,handlers);page.querySelector('.answer-more').click();
      const answer=page.querySelector('.markdown'),input=page.querySelector('.tp-input'),scroller=page.querySelector('.tp-scroll');
      input.value='Task draft 中文';input.focus();input.setSelectionRange(1,4);scroller.scrollTop=1200;const top=scroller.scrollTop;
      for(const locale of ['en','zh-CN','en']){
        setLocale(locale);renderTasksPage(page,stateTask,handlers);
        check(page.querySelector('.markdown')===answer,'Task: Markdown node replaced in '+locale);
        check(answer.querySelectorAll('h3').length===507&&!answer.querySelector('.answer-more'),'Task: expanded answer collapsed in '+locale);
        check(page.querySelector('.tp-input')===input&&input.value==='Task draft 中文','Task: draft or input node lost in '+locale);
        check(document.activeElement===input&&input.selectionStart===1&&input.selectionEnd===4,'Task: focus or input selection lost in '+locale);
        check(Math.abs(scroller.scrollTop-top)<=2,'Task: reading position drifted in '+locale);
        check(page.querySelector('.tp-act').textContent===t('island-tasks.stop'),'Task: operation label kept stale language in '+locale);
        check(input.getAttribute('aria-label')===t('tasks-page.interruption'),'Task: input label kept stale language in '+locale);
      }
      return failures;
    }finally{host.remove();setLocale(previousLocale)}
  })()`)
}
