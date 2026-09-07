import { readFile } from 'node:fs/promises'
import { root } from './helpers.mjs'

export const stats = {
  name: 'example.project-stats', description: 'Project file statistics with a Web panel', dependency_lock: '{}',
  host: await readFile(`${root}/examples/project-stats.host.mjs`, 'utf8'),
  client: await readFile(`${root}/examples/project-stats.client.mjs`, 'utf8'),
}
export const scripted = {
  name: 'test.scripted', description: 'Deterministic provider for cross-language evaluation', client: null, dependency_lock: '{}',
  host: `export default function(ctx) {
    ctx.morrow.policy('00-scripted', async (run, prep, next) => { prep.header.provider = 'scripted'; await next() })
    ctx.morrow.model('scripted', async (request, run) => {
      const text = content => ({role:'assistant',content,reasoning:'',tool_calls:[],tool_call_id:null});
      if (request.purpose === 'summary') return text('Summary: user wants project statistics; preserve completed results.');
      const messages = request.body.messages;
      const last = messages.findLastIndex(m => m.role === 'user');
      const input = messages[last]?.content ?? '';
      if (input.includes('slow')) { await new Promise((resolve,reject) => { const timer=setTimeout(resolve,30000); run.signal.addEventListener('abort',()=>{clearTimeout(timer); reject(new Error('cancelled'))},{once:true}) }); return text('late'); }
      if (messages.slice(last+1).some(m => m.role === 'tool')) return text('Completed.');
      let calls = [];
      if (input.includes('define stats')) calls = [{id:'define',name:'plugin_define',arguments:${JSON.stringify(stats)}}];
      if (input.includes('run stats')) calls = [{id:'stats',name:'project_stats',arguments:{}}];
      if (input.includes('parallel')) calls = [{id:'a',name:'list_files',arguments:{path:'.'}},{id:'b',name:'read_file',arguments:{path:'sample.txt'}}];
      if (input.includes('shell')) calls = [{id:'shell',name:'shell',arguments:{command:'echo approved'}}];
      if (input.includes('unknown')) calls = [{id:'unknown',name:'missing_tool',arguments:{}}];
      if (input.includes('malformed')) calls = [{id:'dup',name:'read_file',arguments:{}},{id:'dup',name:'read_file',arguments:{}}];
      if (input.includes('spawn child')) calls = [{id:'child',name:'subagent',arguments:{prompt:'hello child'}}];
      if (input.includes('activate stats')) calls = [{id:'activate',name:'activate_stats',arguments:{}}];
      if (input.includes('crash host')) calls = [{id:'crash',name:'crash_host',arguments:{}}];
      return {...text(calls.length ? '' : 'Hello from the scripted provider.'),tool_calls:calls};
    })
  }`,
}
