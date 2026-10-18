import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {buildSync} from 'esbuild';

test('source link controls render explicit accessible copy actions without navigation',()=>{
  const compiled=buildSync({stdin:{contents:`
    import React from 'react';
    import {renderToStaticMarkup} from 'react-dom/server';
    import {CopyLink} from './components/copy-link.tsx';
    console.log(JSON.stringify(['Copy source link','Copy server link','Copy RedZone page link'].map(label=>
      renderToStaticMarkup(React.createElement(CopyLink,{url:'https://ppv.st/#26',label},'PPV')))));
  `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,
    external:['react','react-dom/server']});
  const markup:unknown=JSON.parse(execFileSync(process.execPath,['-e',compiled.outputFiles[0].text],{encoding:'utf8'}));
  assert.ok(Array.isArray(markup));
  assert.equal(markup.length,3);
  for(const [index,label] of ['Copy source link','Copy server link','Copy RedZone page link'].entries()){
    const html:unknown=markup[index];assert.equal(typeof html,'string');
    assert.ok(typeof html==='string');
    assert.match(html,/<button type="button"/);
    assert.ok(html.includes(`aria-label="${label}: PPV"`));
    assert.ok(html.includes('PPV'));
    assert.ok(html.includes(label));
    assert.doesNotMatch(html,/<a\b|\bhref=|\btarget=/);
  }
});
