import { test } from 'node:test'
import assert from 'node:assert/strict'
import { McpClient } from '../packages/sdk/dist/index.js'

test('MCP stdio initializes, lists tools, invokes, cancels and disposes', async () => {
  const source = `const readline=require('node:readline');
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line); if(!m.id)return;
      if(m.method==='wait') return;
      const result=m.method==='initialize'?{protocolVersion:'2025-03-26'}:m.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]}:{content:[{type:'text',text:'ok'}]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
    });`
  const client = new McpClient({ name: 'fixture', command: process.execPath, args: ['-e', source] })
  try {
    await client.start()
    assert.equal((await client.call('tools/list', {})).tools[0].name, 'echo')
    assert.equal((await client.call('tools/call', { name: 'echo', arguments: {} })).content[0].text, 'ok')
    const abort = new AbortController()
    const pending = client.call('wait', {}, abort.signal)
    abort.abort()
    await assert.rejects(pending, /cancelled/)
  } finally { client.close() }
})
