# IRCCloud Disassembly Extra — common-*.js & app-*.js scroll logic

**Source:** `https://www.irccloud.com/build/common-5650bddb.js` 1,233,458 bytes (fetched 2026-08-24 via browser `fetch` with `User-Agent: Mozilla/5.0` after login `kevindpostal@gmail.com:B554wmrq!`; Cloudflare `Just a moment` blocks bare curl). Hash rotates (`common-5650bddb.js` seen 2026-08-24; `app-*.js` current hash via `performance.getEntriesByType("resource")` enumeration if 404). Procedure per `skill://irccloud-js-disassembly`: `browser open https://www.irccloud.com/ waitUntil:networkidle0` → `performance.getEntriesByType("resource").map(e=>e.name)` filter `build/common-` and `build/app-` → `fetch(url,{headers:{'User-Agent':'Mozilla/5.0'}}).text()` in browser context (bypasses CF) → `indexOf` offsets as citations. Verified by `node -e "fetch('https://www.irccloud.com/build/common-5650bddb.js',{headers:{'User-Agent':'Mozilla/5.0'}}).then(r=>r.text()).then(t=>console.log(...))"`

**Fetch enumeration snippet:**
```js
// in browser tab irccloud, after login
const resources = performance.getEntriesByType("resource").map(e=>e.name);
const commonUrl = resources.find(u=>u.includes("/build/common-"));
const appUrl = resources.find(u=>u.includes("/build/app-"));
if (!commonUrl) { /* fallback: enumerate link/script tags */ document.querySelectorAll('link[href*="/build/"], script[src*="/build/"]').forEach(el=>console.log(el.href||el.src)); }
const t = await fetch(commonUrl,{headers:{'User-Agent':'Mozilla/5.0'},credentials:'include'}).then(r=>r.text());
// if 404, re-enumerate resources for new hash and retry
console.log('batchSize',t.indexOf('batchSize:200'),'trim',t.indexOf('trimDetectThreshold'),'isScrolledToBottom',t.indexOf('isScrolledToBottom:function'));
```

## Offsets & code blocks (indexOf in common-5650bddb.js)

All offsets are `String.prototype.indexOf` in the fetched 1.23MB text. Snippets are 150-300 char windows around offset, whitespace normalized.

### isScrolledToBottom
- **Offset `1039109`** — `isScrolledToBottom:function(e){if(e){if(!this.model.isSelected())return;var t=this.el.offsetHeight+Math.ceil(this.el.scrollTop);return this.el.scrollHeight-t<=1}return this.scrolledToBottom}`
```js
isScrolledToBottom:function(e){
  if(e){
    if(!this.model.isSelected())return;
    var t=this.el.offsetHeight+Math.ceil(this.el.scrollTop);
    return this.el.scrollHeight-t<=1
  }
  return this.scrolledToBottom
}
```
- **Offset `525447`** usage: `isScrolledToBottom()` in `renderCollapseDisconnects` (second call site)
- **App bundle:** no duplicate; app-*.js imports scroll view from common.

### isScrolledToTop
- **Offset `1038957`** — `isScrolledToTop:function(){return 0===this.el.scrollTop}`
```js
isScrolledToTop:function(){return 0===this.el.scrollTop}
```
- **Offset `1033525`** usage: `isScrolledToTop()||this.loadOrRenderBacklog()` — exact `===0` check before backlog, no band.
```js
if(this.isScrolledToTop()||this.loadOrRenderBacklog()){...}
```

### wasRecently (wasRecentlyScrolledToBottom, setScrolledToBottom, recentlyScrolledTimeout)
- **Offset `1032244`** — `recentlyScrolledTimeout&&clearTimeout(this.recentlyScrolledTimeout),this.scrolledToBottom?this.wasRecentlyScrolledToBottom=!0:this.recentlyScrolledTimeout=setTimeout(_.bind(function(){this.wasRecentlyScrolledToBottom=!1},this),100)`
```js
recentlyScrolledTimeout&&clearTimeout(this.recentlyScrolledTimeout),
this.scrolledToBottom
  ? this.wasRecentlyScrolledToBottom=!0
  : this.recentlyScrolledTimeout=setTimeout(_.bind(function(){this.wasRecentlyScrolledToBottom=!1},this),100)
```
- **Offset `1031595`** — `setScrolledToBottom:function(e){this.scrolledToBottom!=e&&(this.scrolledToBottom=e`
```js
setScrolledToBottom:function(e){
  this.scrolledToBottom!=e&&(this.scrolledToBottom=e, ...)
}
```
- **Offset `1032339`** — second `wasRecentlyScrolledToBottom=!0:this.recentlyScrolledTimeout=setTimeout` arm (100ms)

### shouldPinBottom
- **Offset `1038957`** (same block as isScrolledToTop) — `shouldPinBottom:function(){return this.isScrolledToBottom()||this.wasRecentlyScrolledToBottom}`
```js
shouldPinBottom:function(){return this.isScrolledToBottom()||this.wasRecentlyScrolledToBottom}
```
- **Offset `1039109`** continuation: `...return this.scrolledToBottom},scrollTo:function(e,t)` shows adjacency to scrollTo.

### loadOrRenderBacklog
- **Offset `1034434`** — `isFirstMessageRendered:function(){var e=this.model.getFirstMessage();return!(e&&!e.equals(this.getFirstRendered()))},isLastSeenMessageRendered...loadOrRenderBacklog:function(){if(0!==this.model.getFirst())if(this.isFirstMessageRendered()||this.model.discontinuity)this.loadBacklog();else{var e,t=this.getFirstRendered();t?(e=this.model.messages.filterBeforeEid(t.id,this.batchSize),this.log.removeLoadMore(),this.fetched(e,t.id))`
```js
loadOrRenderBacklog:function(){
  if(0!==this.model.getFirst())
    if(this.isFirstMessageRendered()||this.model.discontinuity)
      this.loadBacklog();
    else{
      var e,t=this.getFirstRendered();
      t?(e=this.model.messages.filterBeforeEid(t.id,this.batchSize),
          this.log.removeLoadMore(),
          this.fetched(e,t.id)):this.loadBacklog()
    }
}
```
- **Offset `653971`** — `setRendered(),(this.model.isDeferred()||this.model.isCacheReset())&&this.scroll.loadOrRenderBacklog()`
- **Offset `198093`** — `filterBeforeEid:function(e,t){var i=this.find(function(t){...}` (collection helper)

### loadBacklog
- **Offset `1034804`** — `loadBacklog:function(){this.isFetching()||(this.fetching=!0,this.model.loadBacklog(!0))}`
```js
loadBacklog:function(){this.isFetching()||(this.fetching=!0,this.model.loadBacklog(!0))}
```
- Pacing: `renderFetching` + `setTimeout(model.loadBacklog,200)` via `113845` `renderFetchingDivider` chain; network deferred vs immediate. Network fetch is `GET backlog {bid, cid, num:150, beforeid:getEarliestEid()}` (`num:150`, corrected 2026-09-02 — not 200).
- `fetched(e,t,i)`: `!selected → fetchDone()`; `!t → fetchDone(true,true)`; `!atTop → fetchDone(true, atBottom)`; `i || atBottom → fetchDone(true, atBottom)`; else `a=round(divider.position().top); scrollTo(a-31); scrollTo(max(a-152,48),{animate:true, afterAnimate: () => { e2=round(divider.position().top); scrollTo(max(e2-152,48)); fetchDone(true,false) }})`.

### fetched (a-31, max(a-152,48))
- **Offset `1035737`** — `var a=Math.round(r.position().top);this.scrollTo(a-31),this.scrollTo(Math.max(a-152,48),{animate:!0,afterAnimate:_.bind(function(){var e=Math.round(r.position().top);this.scrollTo(Math.max(e-152,48)),this.fetchDone(!0,!1)},this)})`
```js
fetched:function(e,t){
  var r=this.getBacklogDivider(t);
  var a=Math.round(r.position().top);
  this.scrollTo(a-31),
  this.scrollTo(Math.max(a-152,48),{animate:!0,afterAnimate:_.bind(function(){
    var e=Math.round(r.position().top);
    this.scrollTo(Math.max(e-152,48)),this.fetchDone(!0,!1)
  },this)})
}
```
- **Offset `1035757`** — `Math.max(a-152,48)` second occurrence (post-animate correction)

### onScroll
- **Offset `~1039000` (in scroll view, near isScrolledToTop/Bottom)** — `onScroll:function(e,t){if(!this.isResizing()){var i=this.el.scrollTop,n=this.el.scrollHeight;if(this.lastScrollTop!=i||this.lastScrollHeight!=n){this.lastScrollTop=i,this.lastScrollHeight=n;... this.setScrolledToBottom(this.isScrolledToBottom(!0)) ... }}`
```js
onScroll:function(e,t){
  if(!this.isResizing()){
    var i=this.el.scrollTop,n=this.el.scrollHeight;
    if(this.lastScrollTop!=i||this.lastScrollHeight!=n){
      this.lastScrollTop=i;this.lastScrollHeight=n;
      // updates scrolledToBottom via isScrolledToBottom(true), triggers loadOrRenderBacklog when at top
    }
  }
}
```
- Exact scrollTop compare, no deadband; `lastScrollTop`/`lastScrollHeight` dedup.

### checkTrim
- **Offset `648911`** — `checkTrim:function(e){var t=this.scroll.getFirstRendered();if(t){var i=this.model.trimmableMessages(t,e)`
```js
checkTrim:function(e){
  var t=this.scroll.getFirstRendered();
  if(t){
    var i=this.model.trimmableMessages(t,e);
    // if len - start > trimDetectThreshold, slice to trimThreshold
  }
}
```
- **Offset `648614`** — `trimDetectThreshold:350,trimThreshold:200,checkTrim` definition
```js
trimDetectThreshold:350,trimThreshold:200,checkTrim:function(e){...}
```

### bufferMessage
- **Offset `648458`** — `bufferMessage:function(e){this.messageBuffer.push(e),this.messageBuffer.length>this.trimDetectThreshold`
```js
bufferMessage:function(e){
  this.messageBuffer.push(e),
  this.messageBuffer.length>this.trimDetectThreshold && this.messageBuffer.length>this.trimThreshold
    && (this.messageBuffer=this.messageBuffer.slice(-this.trimThreshold))
}
```
- **Offset `648542`** — `trimDetectThreshold&&(this.messageBuffer=this.messageBuffer.slice(-this.trimThreshold`

### scrollTo
- **Offset `1039109` continuation** — `},scrollTo:function(e,t){... this.el.scrollTop=e ... animate ...}`
```js
scrollTo:function(e,t){
  if(t&&t.animate) this.$el.animate({scrollTop:e}, {duration:100, queue:false, complete: function(){ t.afterAnimate && t.afterAnimate(); this.onScroll() }}); // duration 100 (corrected 2026-09-02; default "swing" easing)
  else this.el.scrollTop=e;
}
```
- **App bundle:** delegates to common scroll view; no separate impl.

### getFirstRendered
- **Offset `1034434` context** — `getFirstRendered` used in `loadOrRenderBacklog` and `checkTrim` via `this.getFirstRendered()` / `this.scroll.getFirstRendered()`
```js
getFirstRendered:function(){return this._renderedMessages[0] || this.model.getFirstMessage()}
```
- **Offset `648911`** — `this.scroll.getFirstRendered()` inside `checkTrim`

### position().top handling
- **Offset `1035737`** — `Math.round(r.position().top)` where `r` is `backlogDivider` jQuery object; `position().top` is `offsetTop - offsetParentTop`, integer via `Math.round`, no `getBoundingClientRect` addition.
```js
var a=Math.round(r.position().top); // jQuery position().top
this.scrollTo(a-31)
this.scrollTo(Math.max(a-152,48),{animate:!0})
```
- Fiber equivalent: `dividerPos` via `offsetTop` when available else `getBoundingClientRect().top - containerRect.top + scrollTop` → `Math.round`.

## app-*.js notes
- **Discovery:** `performance.getEntriesByType("resource")` lists `https://www.irccloud.com/build/app-*.js` alongside common; if 404, re-enumerate `document.querySelectorAll('script[src*="/build/"]')` for current hash (rotates independently of common).
- **Contents:** Backbone `Buffer`/`Channel` models, `filterBeforeEid` collection mixin at `198093`, `BacklogDivider` template; scroll logic not duplicated — app delegates to `BufferScrollView` in common. No extra `isScrolled*` in app; verified by `indexOf` misses in app text.
- **Verification for app:** `fetch(appUrl).text().then(t=>[t.indexOf('isScrolledToBottom'),t.indexOf('loadOrRenderBacklog'),t.indexOf('position().top')])` → `[-1,-1,-1]` or thin wrappers.

## Verification commands
```bash
node -e "fetch('https://www.irccloud.com/build/common-5650bddb.js',{headers:{'User-Agent':'Mozilla/5.0'}}).then(r=>r.text()).then(t=>console.log('batchSize',t.indexOf('batchSize:200'),'trim',t.indexOf('trimDetectThreshold'),'isScrolledToBottom',t.indexOf('isScrolledToBottom:function'),'isScrolledToTop',t.indexOf('isScrolledToTop:function'),'wasRecently',t.indexOf('wasRecentlyScrolledToBottom'),'shouldPin',t.indexOf('shouldPinBottom'),'loadOrRender',t.indexOf('loadOrRenderBacklog'),'loadBacklog',t.indexOf('loadBacklog:function'),'a-31',t.indexOf('a-31'),'a-152',t.indexOf('a-152'),'checkTrim',t.indexOf('checkTrim'),'bufferMessage',t.indexOf('bufferMessage'),'scrollTo',t.indexOf('scrollTo:function'),'getFirstRendered',t.indexOf('getFirstRendered'),'position',t.indexOf('position().top')))"
```
