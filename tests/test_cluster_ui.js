const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = vm.createContext({ window: {}, String, Math, Number });
vm.runInContext(fs.readFileSync(__dirname + '/../cards.js', 'utf8'), context);
context.AgentsCards = context.window.AgentsCards;
vm.runInContext(fs.readFileSync(__dirname + '/../cluster.js', 'utf8'), context);
const C = context.window.AgentsCluster;

// kgpus nests a bold around a 256-colour user name and resets twice.
assert.equal(C.ansi('\x1b[1m\x1b[38;5;141malice\x1b[0m\x1b[0m <x>'),
  '<span class="a-b" style="color:rgb(175,135,255)">alice</span> &lt;x&gt;');
assert.equal(C.ansi('\x1b[2mfull\x1b[0m'), '<span class="a-d">full</span>');
assert.equal(C.ansi('\x1b[H\x1b[2Jplain'), 'plain');

const gpus = ' node1  b300  \x1b[2mfull\x1b[0m\n\n \x1b[1mfree\x1b[0m    \x1b[2mb300 0\x1b[0m   \x1b[32mh100 6\x1b[0m   \x1b[32ma6000 18\x1b[0m\n';
assert.deepEqual(JSON.parse(JSON.stringify(C.freeGpus(gpus))), [['h100', 6], ['a6000', 18]]);

const jobs = [
  '             JOBID PARTITION     NAME     USER ST       TIME  NODES NODELIST(REASON)',
  '            222383      long train-a   alice PD       0:00      1 (DependencyNeverSatisfied)',
  '            222285  standard eval-b   alice  R    5:24:20      1 node2',
].join('\n');
assert.deepEqual({ ...C.jobCounts(jobs) }, { running: 1, pending: 1 });

// Counting only the shared partitions: a pending job lists every partition it may run on.
const tjobs = [
  '         JOBID                     NAME ST       TIME NODES PARTITION',
  '    2902247           finetune  R       4:29     1 lab-shared-a6000',
  '  2900967_19             sweep  R       5:44     1 lab-private-h100',
  '    2888457                    pretrain PD       0:00     1 lab-shared-h100,lab-shared-h200,dept-shared-h200',
  '    2902300                     hold PD       0:00     1 lab-private-h100',
  '    2902301                    other  R       1:00     1 old-titanxp,dept-shared-l40s',
].join('\n');
assert.deepEqual({ ...C.jobCounts(tjobs, ['lab-shared', 'dept-shared']) }, { running: 2, pending: 1 });
assert.deepEqual({ ...C.jobCounts(tjobs) }, { running: 3, pending: 2 });
const t = { name: 'lab', host: 'login.example.edu', count: ['lab-shared', 'dept-shared'],
  connected: true, fetching: false, fetched: 1000, every: 1200, commands: { gpus: 'tgpus', jobs: 'squeue' },
  output: { gpus: ' free    h200 0   h100 0   v100 16   3090 17\n', jobs: tjobs }, errors: {} };
assert.match(C.button(t), /^lab .*<b>v100 16<\/b> <b>3090 17<\/b> free.* 2 running.* 1 queued/);

const k = { name: 'gpu', count: [], host: 'gpu.example.edu', connected: true, fetching: false, fetched: 1000, every: 1200,
  commands: { gpus: 'kgpus --color', jobs: 'squeue -u "$USER"' }, output: { gpus, jobs }, errors: {} };
assert.match(C.button(k), /<b>h100 6<\/b> <b>a6000 18<\/b> free.*1 running.*1 queued/);
assert.match(C.head(k, 1000 + 180), /updated .* \(3m ago\) · next in 17m/);
assert.match(C.body({ ...k, errors: { gpus: 'timed out' } }), /failed: timed out \(showing the last good one\)/);

console.log('UI: cluster panel rendering passed');
