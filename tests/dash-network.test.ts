import assert from 'node:assert/strict';
import test from 'node:test';
import {dashRequestUrl} from '../components/dash-playback.ts';

const root=`http://127.0.0.1:3000/api/stream/media/${'a'.repeat(48)}`;
const virtual=`https://${'a'.repeat(48)}.dash.invalid`;
test('DASH networking maps root refresh, nested bases and absolute children to one local capability',()=>{
  assert.equal(dashRequestUrl(root,root,'manifest'),root);
  assert.equal(dashRequestUrl(root,virtual+'/sport/manifest.mpd','manifest',virtual+'/sport/manifest.mpd'),root);
  assert.equal(dashRequestUrl(root,virtual+'/tracks/segment-00001.m4s?token=owned','segment'),
    root+'?reference=%2Ftracks%2Fsegment-00001.m4s%3Ftoken%3Downed&kind=segment');
  assert.equal(dashRequestUrl(root,'https://cdn.example/init.mp4','segment'),
    root+'?reference=https%3A%2F%2Fcdn.example%2Finit.mp4&kind=segment');
});
test('DASH networking fails closed for escaped virtual hosts, local requests and unsupported schemes',()=>{
  for(const uri of [virtual.replace('a.dash','q.dash')+'/track',root+'?reference=changed',
    'http://remote.example/file','https://user:password@cdn.example/file','data:video/mp4,foo',
    'https://cdn.example/file#fragment'])assert.throws(()=>dashRequestUrl(root,uri,'segment'),/Unsupported/);
});
