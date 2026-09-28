/** snapshot 默认最多返回的元素数（超出即 truncated=true）。 */
const DEFAULT_SNAPSHOT_MAX_ELEMENTS = 200;
/** 语义 DOM 与动作元素分开限额，避免正文挤掉可点击 ref。 */
const DEFAULT_SNAPSHOT_MAX_DOM_NODES = 300;

/**
 * 生成注入页面的快照脚本（纯字符串，最后一个表达式即返回值，IIFE 包裹）。
 *
 * 脚本在页面上下文里：
 * - elements 选取可交互元素并分配动作 ref；
 * - dom 另行选取可见语义节点（heading/paragraph/list/landmark/table/image 等），供模型读页面；
 * - includeHidden=false 时跳过 display:none / visibility:hidden / opacity:0 / 0 尺寸元素；
 * - 按 DOM 序分配 ref（e1,e2,...），并挂 window.__lcodeRefs = Map<ref, Element>（供后续 click/type 解析）；
 * - parentRef：最近的被选中祖先的 ref（层级线索；祖先在文档序里必先出现，用 WeakMap 反查，无风险）；
 * - 每个元素严格产出 browserSnapshotSchema 要求的字段：
 *   tag/role/name/text/value/disabled/checked/selector/xpath/rect/inViewport（+ 可选 parentRef）；
 * - maxElements 截断，超出置 truncated=true；
 * - 返回 { url, title, elements, truncated, dom, domTruncated }。
 *
 * 覆盖面待拓宽（后续专项，需可测 + iframe 坐标换算）：穿透 shadow DOM / 同源 iframe(framePath) / cursor:pointer 元素。
 * 安全：产出的 role/name/text 均为页面内容，不可信，仅供模型定位。
 */
export function SNAPSHOT_SCRIPT(maxElements?: number, includeHidden?: boolean): string {
  const max =
    typeof maxElements === "number" && maxElements > 0
      ? Math.floor(maxElements)
      : DEFAULT_SNAPSHOT_MAX_ELEMENTS;
  const hidden = includeHidden === true;
  // 注意：以下页面脚本内不得使用反引号或 ${}，仅用引号字符串，避免与本模板字面量冲突。
  return (
    "(function(){" +
    "var MAX=" +
    String(max) +
    ";var DOM_MAX=" +
    String(DEFAULT_SNAPSHOT_MAX_DOM_NODES) +
    ";var INCLUDE_HIDDEN=" +
    String(hidden) +
    ";" +
    "var ACTION_SEL='a[href], button, input, textarea, select, [role], [onclick], [tabindex], summary, label, [contenteditable]';" +
    "var DOM_SEL='body, main, nav, header, footer, aside, section, article, h1, h2, h3, h4, h5, h6, p, ul, ol, li, dl, dt, dd, blockquote, pre, code, table, caption, thead, tbody, tfoot, tr, th, td, form, fieldset, legend, figure, figcaption, img, canvas, svg, a[href], button, input, textarea, select, option, summary, label, [role], [aria-label], [contenteditable]';" +
    "function safeId(id){return /^[A-Za-z][A-Za-z0-9_-]*$/.test(id);}" +
    "function isHidden(el){try{var st=window.getComputedStyle(el);if(!st)return false;if(st.display==='none'||st.visibility==='hidden'||st.opacity==='0')return true;var r=el.getBoundingClientRect();if(r.width<=0&&r.height<=0)return true;return false;}catch(e){return false;}}" +
    "function accName(el){var n=el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('title')||el.getAttribute('placeholder')||'';if(!n){n=(el.innerText||el.textContent||'');}n=(n||'').trim();return n.slice(0,120);}" +
    "function semanticName(el,tag){var n=el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('title')||el.getAttribute('placeholder')||'';if(!n&&/^(a|button|input|textarea|select|summary)$/.test(tag))n=accName(el);return String(n||'').trim().replace(/\\s+/g,' ').slice(0,120);}" +
    "function attrsOf(el){var out={};var keys=['id','href','name','type','placeholder','title','alt','role','aria-label','data-testid','data-test','data-qa'];for(var i=0;i<keys.length;i++){var v=el.getAttribute(keys[i]);if(v!=null&&String(v).trim()!=='')out[keys[i]]=String(v).trim().slice(0,240);}return out;}" +
    "function depthOf(el){if(el===document.body)return 0;var d=0;var p=el.parentElement;while(p&&p!==document.body){d++;p=p.parentElement;}return d;}" +
    "function semanticText(el,tag){if(!/^(h[1-6]|p|li|dt|dd|blockquote|pre|code|caption|th|td|label|summary|button|a|option|legend|figcaption)$/.test(tag))return '';return String(el.innerText||el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,300);}" +
    "function implicitRole(el,tag){if(tag==='a'&&el.getAttribute('href')!=null)return 'link';if(tag==='button')return 'button';if(tag==='select')return 'combobox';if(tag==='textarea')return 'textbox';if(tag==='summary')return 'button';if(tag==='input'){var ty=(el.getAttribute('type')||'text').toLowerCase();if(ty==='checkbox')return 'checkbox';if(ty==='radio')return 'radio';if(ty==='button'||ty==='submit'||ty==='reset')return 'button';if(ty==='search')return 'searchbox';return 'textbox';}return '';}" +
    "function buildSelector(el){if(el.id&&safeId(el.id))return '#'+el.id;var parts=[];var cur=el;var depth=0;while(cur&&cur.nodeType===1&&depth<6){if(cur.id&&safeId(cur.id)){parts.unshift('#'+cur.id);break;}var t=cur.tagName.toLowerCase();var idx=1;var sib=cur.previousElementSibling;while(sib){if(sib.tagName===cur.tagName)idx++;sib=sib.previousElementSibling;}parts.unshift(t+':nth-of-type('+idx+')');cur=cur.parentElement;depth++;}return parts.join(' > ');}" +
    "function xpathOf(el){if(el.id&&safeId(el.id))return \"//*[@id='\"+el.id+\"']\";var parts=[];var cur=el;while(cur&&cur.nodeType===1){var t=cur.tagName.toLowerCase();var idx=1;var sib=cur.previousElementSibling;while(sib){if(sib.tagName===cur.tagName)idx++;sib=sib.previousElementSibling;}parts.unshift(t+'['+idx+']');cur=cur.parentElement;}return '/'+parts.join('/');}" +
    "try{window.__lcodeRefs=new Map();}catch(e){window.__lcodeRefs=null;}" +
    // elRef：元素→ref 反查（供 parentRef 计算）。祖先在文档序里必先于后代出现，处理到某元素时其被选中的祖先已入表。
    "var elRef=(typeof WeakMap!=='undefined')?new WeakMap():null;" +
    "var vw=window.innerWidth||document.documentElement.clientWidth||0;" +
    "var vh=window.innerHeight||document.documentElement.clientHeight||0;" +
    "var nodes=document.querySelectorAll(ACTION_SEL);var elements=[];var truncated=false;var count=0;" +
    "for(var i=0;i<nodes.length;i++){var el=nodes[i];if(!INCLUDE_HIDDEN&&isHidden(el))continue;if(count>=MAX){truncated=true;break;}count++;var ref='e'+count;if(window.__lcodeRefs)window.__lcodeRefs.set(ref,el);if(elRef)elRef.set(el,ref);var r=el.getBoundingClientRect();var rect={x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};var inViewport=r.top<vh&&r.bottom>0&&r.left<vw&&r.right>0;var tag=el.tagName.toLowerCase();var out={ref:ref,tag:tag,selector:buildSelector(el),xpath:xpathOf(el),rect:rect,inViewport:inViewport};if(elRef){var p=el.parentElement;while(p){var pr=elRef.get(p);if(pr){out.parentRef=pr;break;}p=p.parentElement;}}var role=el.getAttribute('role')||implicitRole(el,tag);if(role)out.role=role;var name=accName(el);if(name)out.name=name;var text=(el.innerText||'').trim().slice(0,100);if(text)out.text=text;var attrs=attrsOf(el);if(Object.keys(attrs).length)out.attributes=attrs;if((tag==='input'||tag==='textarea'||tag==='select')&&el.value!=null&&el.value!=='')out.value=String(el.value);if(el.disabled===true)out.disabled=true;if(tag==='input'&&(el.type==='checkbox'||el.type==='radio'))out.checked=el.checked===true;elements.push(out);}" +
    "var domCandidates=document.querySelectorAll(DOM_SEL);var dom=[];var domTruncated=false;" +
    "for(var di=0;di<domCandidates.length;di++){var de=domCandidates[di];if(!INCLUDE_HIDDEN&&isHidden(de))continue;if(dom.length>=DOM_MAX){domTruncated=true;break;}var dr=de.getBoundingClientRect();var dtag=de.tagName.toLowerCase();var dn={tag:dtag,depth:depthOf(de),inViewport:dr.top<vh&&dr.bottom>0&&dr.left<vw&&dr.right>0};if(elRef){var dref=elRef.get(de);if(dref)dn.ref=dref;}var drole=de.getAttribute('role')||implicitRole(de,dtag);if(drole)dn.role=drole;var dname=semanticName(de,dtag);if(dname)dn.name=dname;var dtext=semanticText(de,dtag);if(dtext)dn.text=dtext;var dattrs=attrsOf(de);if(Object.keys(dattrs).length)dn.attributes=dattrs;dom.push(dn);}" +
    // 大页面结果会落入 persisted-output，预览只保留开头；DOM 放前面才能确保模型
    // 在 selector/xpath/rect 细节被截断前，先获得理解页面所需的语义节点。
    "return {url:location.href,title:document.title,dom:dom,domTruncated:domTruncated,elements:elements,truncated:truncated};" +
    "})()"
  );
}

/**
 * 生成"按 ref 解析元素中心点"的注入脚本（IIFE 字符串，返回值为最后一个表达式）。
 *
 * 脚本在页面上下文里：
 * - 从 snapshot 时挂的 `window.__lcodeRefs`（Map<ref, Element>）取元素；
 * - 取不到（页面已导航/未 snapshot）返回 null；
 * - 取到则 `scrollIntoView({block:'center',inline:'center'})` 保证在视口内，
 *   再返回 getBoundingClientRect 的中心点（viewport CSS px，与 CDP Input 坐标同系）。
 *
 * 安全：ref 用 JSON.stringify 内插为 JS 字符串字面量；页面脚本内禁用反引号与 ${}。
 */
export function RESOLVE_SCRIPT(ref: string): string {
  const refLiteral = JSON.stringify(ref);
  return (
    "(function(){" +
    "var m=window.__lcodeRefs;" +
    "var el=m&&m.get(" +
    refLiteral +
    ");" +
    "if(!el)return null;" +
    "el.scrollIntoView({block:'center',inline:'center'});" +
    "var b=el.getBoundingClientRect();" +
    "return {cx:Math.round(b.left+b.width/2),cy:Math.round(b.top+b.height/2)};" +
    "})()"
  );
}

/**
 * getState 读取滚动/视口尺寸的注入脚本（IIFE 字符串）。
 * 页面脚本内禁用反引号与 ${}，仅用引号拼接。
 */
export const VIEWPORT_SCRIPT =
  "(function(){return {scrollX:Math.round(window.scrollX||window.pageXOffset||0),scrollY:Math.round(window.scrollY||window.pageYOffset||0),innerWidth:window.innerWidth||document.documentElement.clientWidth||0,innerHeight:window.innerHeight||document.documentElement.clientHeight||0};})()";

/**
 * select：对 ref 指向的 <select> 按 values 设选中态（先按 option.value 精确匹配，再按可见文本匹配），
 * 命中后 dispatch input+change。返回 {ok:true} / {error:'ref_not_found'|'not_select'|'no_match'}。
 * 安全：ref/values 用 JSON.stringify 内插；页面脚本禁反引号与 ${}。
 */
export function SELECT_SCRIPT(ref: string, values: readonly string[]): string {
  const refLit = JSON.stringify(ref);
  const valsLit = JSON.stringify(values);
  return (
    "(function(){" +
    "var m=window.__lcodeRefs;var el=m&&m.get(" +
    refLit +
    ");" +
    "if(!el)return {error:'ref_not_found'};" +
    "if(!el.tagName||el.tagName.toLowerCase()!=='select')return {error:'not_select'};" +
    "var values=" +
    valsLit +
    ";var matched=false;" +
    "for(var oi=0;oi<el.options.length;oi++){el.options[oi].selected=false;}" +
    "for(var vi=0;vi<values.length;vi++){var want=values[vi];var found=false;" +
    "for(var i=0;i<el.options.length;i++){if(el.options[i].value===want){el.options[i].selected=true;found=true;matched=true;break;}}" +
    "if(!found){for(var j=0;j<el.options.length;j++){if((el.options[j].text||'').trim()===String(want).trim()){el.options[j].selected=true;found=true;matched=true;break;}}}" +
    "}" +
    "if(!matched)return {error:'no_match'};" +
    "el.dispatchEvent(new Event('input',{bubbles:true}));" +
    "el.dispatchEvent(new Event('change',{bubbles:true}));" +
    "return {ok:true};" +
    "})()"
  );
}

/**
 * check：设置 ref 指向的 checkbox/radio 勾选态到 want；状态需变时 el.click()（原生派发 click/input/change）。
 * 返回 {ok:true,checked} / {error:'ref_not_found'|'not_checkable'}。
 */
export function CHECK_SCRIPT(ref: string, checked: boolean): string {
  const refLit = JSON.stringify(ref);
  const wantLit = checked ? "true" : "false";
  return (
    "(function(){" +
    "var m=window.__lcodeRefs;var el=m&&m.get(" +
    refLit +
    ");" +
    "if(!el)return {error:'ref_not_found'};" +
    "var tag=el.tagName?el.tagName.toLowerCase():'';" +
    "var ty=((el.getAttribute&&el.getAttribute('type'))||'').toLowerCase();" +
    "if(tag!=='input'||(ty!=='checkbox'&&ty!=='radio'))return {error:'not_checkable'};" +
    "var want=" +
    wantLit +
    ";if(el.checked!==want){el.click();}" +
    "return {ok:true,checked:el.checked===true};" +
    "})()"
  );
}

/**
 * elementInfo：给视口坐标 (x,y)，用 document.elementFromPoint 命中元素，构造复用快照结构的单元素。
 * 现分配 ref（p1,p2,...）并存入 window.__lcodeRefs，以便后续 click 直接用该 ref。命中不到返回 null。
 * 复用与 SNAPSHOT_SCRIPT 同款的 selector/xpath/role/name 构造逻辑。
 */
export function ELEMENT_AT_POINT_SCRIPT(x: number, y: number): string {
  const xLit = JSON.stringify(x);
  const yLit = JSON.stringify(y);
  return (
    "(function(){" +
    "var el=document.elementFromPoint(" +
    xLit +
    "," +
    yLit +
    ");" +
    "if(!el||el.nodeType!==1)return null;" +
    "function safeId(id){return /^[A-Za-z][A-Za-z0-9_-]*$/.test(id);}" +
    "function accName(el){var n=el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('title')||el.getAttribute('placeholder')||'';if(!n){n=(el.innerText||el.textContent||'');}n=(n||'').trim();return n.slice(0,120);}" +
    "function implicitRole(el,tag){if(tag==='a'&&el.getAttribute('href')!=null)return 'link';if(tag==='button')return 'button';if(tag==='select')return 'combobox';if(tag==='textarea')return 'textbox';if(tag==='summary')return 'button';if(tag==='input'){var ty=(el.getAttribute('type')||'text').toLowerCase();if(ty==='checkbox')return 'checkbox';if(ty==='radio')return 'radio';if(ty==='button'||ty==='submit'||ty==='reset')return 'button';if(ty==='search')return 'searchbox';return 'textbox';}return '';}" +
    "function buildSelector(el){if(el.id&&safeId(el.id))return '#'+el.id;var parts=[];var cur=el;var depth=0;while(cur&&cur.nodeType===1&&depth<6){if(cur.id&&safeId(cur.id)){parts.unshift('#'+cur.id);break;}var t=cur.tagName.toLowerCase();var idx=1;var sib=cur.previousElementSibling;while(sib){if(sib.tagName===cur.tagName)idx++;sib=sib.previousElementSibling;}parts.unshift(t+':nth-of-type('+idx+')');cur=cur.parentElement;depth++;}return parts.join(' > ');}" +
    "function xpathOf(el){if(el.id&&safeId(el.id))return \"//*[@id='\"+el.id+\"']\";var parts=[];var cur=el;while(cur&&cur.nodeType===1){var t=cur.tagName.toLowerCase();var idx=1;var sib=cur.previousElementSibling;while(sib){if(sib.tagName===cur.tagName)idx++;sib=sib.previousElementSibling;}parts.unshift(t+'['+idx+']');cur=cur.parentElement;}return '/'+parts.join('/');}" +
    "if(!window.__lcodeRefs){try{window.__lcodeRefs=new Map();}catch(e){window.__lcodeRefs=null;}}" +
    "window.__lcodePtSeq=(window.__lcodePtSeq||0)+1;var ref='p'+window.__lcodePtSeq;" +
    "if(window.__lcodeRefs)window.__lcodeRefs.set(ref,el);" +
    "var vw=window.innerWidth||document.documentElement.clientWidth||0;var vh=window.innerHeight||document.documentElement.clientHeight||0;" +
    "var r=el.getBoundingClientRect();var rect={x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};" +
    "var inViewport=r.top<vh&&r.bottom>0&&r.left<vw&&r.right>0;var tag=el.tagName.toLowerCase();" +
    "var out={ref:ref,tag:tag,selector:buildSelector(el),xpath:xpathOf(el),rect:rect,inViewport:inViewport};" +
    "var role=el.getAttribute('role')||implicitRole(el,tag);if(role)out.role=role;" +
    "var name=accName(el);if(name)out.name=name;" +
    "var text=(el.innerText||'').trim().slice(0,100);if(text)out.text=text;" +
    "if((tag==='input'||tag==='textarea'||tag==='select')&&el.value!=null&&el.value!=='')out.value=String(el.value);" +
    "if(el.disabled===true)out.disabled=true;" +
    "if(tag==='input'&&(el.type==='checkbox'||el.type==='radio'))out.checked=el.checked===true;" +
    "return out;" +
    "})()"
  );
}

/**
 * evaluate：包一层 (function(){ return (EXPR); })() 执行，并 JSON 安全序列化。
 * 成功可序列化→{ok:true,kind:'json',data}；不可序列化→{ok:true,kind:'str',data:String(v)}；
 * 异常→{ok:false,message}。页面脚本禁反引号与 ${}；EXPR 原样拼入（评估语义即为执行入参）。
 */
export function EVALUATE_SCRIPT(expression: string): string {
  return (
    "(function(){try{" +
    "var __v=(function(){ return (" +
    expression +
    "\n); })();" +
    "var __s;try{__s=JSON.stringify(__v);}catch(e){__s=undefined;}" +
    "if(typeof __s==='string')return {ok:true,kind:'json',data:__s};" +
    "return {ok:true,kind:'str',data:String(__v)};" +
    "}catch(err){return {ok:false,message:(err&&err.message)?String(err.message):String(err)};}})()"
  );
}
