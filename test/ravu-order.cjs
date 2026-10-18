// Execute the shipped GLSL accumulation block and upstream unrolled reference.
// This float32 oracle checks math/order; native GPU pixels and compile time are
// tested separately because a CPU interpreter cannot model driver contraction.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const half = require('../fi-quality.js');
const root = path.resolve(__dirname, '..');
const context = {};
vm.runInNewContext(fs.readFileSync(path.join(root, 'third_party/ravu-lite/ravu-lite-webgl2.js'), 'utf8'), context);
const candidate = context.__fvRavuShaders.step1;
const classifier = context.__fvRavuShaders.classify;
assert.equal(typeof classifier, 'string');
const upstream = fs.readFileSync(path.join(root, 'third_party/ravu-lite/ravu-lite-ar-r3.hook'), 'utf8');
const block = (text, end) => {
  const begin = text.indexOf('vec4 res = vec4(0.0), w;');
  const finish = text.indexOf(end, begin);
  assert.ok(begin >= 0 && finish > begin, 'actual shader accumulation block exists');
  return text.slice(begin, finish).replace(/ravu_lite_lut3/g, 'u_lut');
};
const referenceText = block(upstream, 'return res;');
const candidateText = block(candidate, 'outColor = res;');
const normalizeLines = text => text.replace(/\r\n/g, '\n').trim();
const upstreamClassBody = upstream.slice(upstream.indexOf('float luma0'), upstream.indexOf('vec4 res ='))
  .replace(/HOOKED_texOff\(vec2\(([-\d.]+), ([-\d.]+)\)\)\.x/g, (_, x, y) => 'loadLuma(base + ivec2(' + Number(x) + ', ' + Number(y) + '))');
assert.equal(normalizeLines(classifier.slice(classifier.indexOf('float a = abd.x'), classifier.indexOf('float classificationRow ='))),
  normalizeLines(upstreamClassBody.slice(upstreamClassBody.indexOf('float a = abd.x'), upstreamClassBody.indexOf('float coord_y ='))),
  'eigensystem and LUT classification remain unchanged');
const generator = fs.readFileSync(path.join(root, 'test/generate-ravu-port.ps1'), 'utf8');
const compose = generator.match(/\$compose = @'\r?\n([\s\S]*?)\r?\n'@/);
assert.ok(compose, 'original generated compose shader exists');
assert.equal(normalizeLines(context.__fvRavuShaders.compose), normalizeLines(compose[1]), 'original composition shader remains unchanged');
const bytes = fs.readFileSync(path.join(root, 'third_party/ravu-lite/ravu-lite-lut3.bin'));
assert.equal(bytes.length, 13 * 288 * 4 * 4, 'the fixed shader LUT has thirteen taps');
const lut = Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4));
const f = Math.fround;
const lanes = (a, b, op) => Array.isArray(a) || Array.isArray(b)
  ? Array.from({ length: Array.isArray(a) ? a.length : b.length }, (_, i) => op(Array.isArray(a) ? a[i] : a, Array.isArray(b) ? b[i] : b))
  : op(a, b);
const arithmetic = (op, a, b, integer = false) => lanes(a, b, (x, y) => f(op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : op === '%' ? x % y : integer ? Math.trunc(x / y) : x / y));

// A deliberately small GLSL subset parser. Expressions remain trees so every
// source-level arithmetic operation rounds independently and keeps its order.
function parse(source) {
  source = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/float\[\d+\]\(/g, 'array(');
  const tokens = source.match(/(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_]\w*|\+=|\*=|\+\+|>=|==|\|\||[{}()[\].,;=+*/%<>-]/g) || [];
  let pos = 0;
  const peek = () => tokens[pos];
  const take = expected => { const value = tokens[pos++]; if (expected !== undefined) assert.equal(value, expected); return value; };
  const prec = { '||': 1, '==': 2, '<': 3, '>=': 3, '+': 4, '-': 4, '*': 5, '/': 5, '%': 5 };
  function expression(min = 0) {
    let value;
    const token = take();
    if (token === '(') { value = expression(); take(')'); }
    else if (token === '-') value = ['binary', '-', ['number', 0, true], expression(6)];
    else if (/^(?:\d|\.)/.test(token)) value = ['number', Number(token), !/[.eE]/.test(token)];
    else value = ['name', token];
    while (true) {
      if (peek() === '(') {
        take(); const args = [];
        if (peek() !== ')') { do { args.push(expression()); if (peek() !== ',') break; take(); } while (true); }
        take(')'); value = ['call', value, args];
      } else if (peek() === '[') { take(); const index = expression(); take(']'); value = ['index', value, index]; }
      else if (peek() === '.') { take(); value = ['swizzle', value, take()]; }
      else if (prec[peek()] !== undefined && prec[peek()] >= min) {
        const op = take(); value = ['binary', op, value, expression(prec[op] + 1)];
      } else break;
    }
    return value;
  }
  function simple() {
    if (peek() === 'const') take();
    if (['float', 'int', 'vec2', 'vec3', 'ivec2', 'vec4'].includes(peek())) {
      const type = take(), vars = [];
      do {
        const name = take();
        if (peek() === '[') { take(); take(); take(']'); }
        let init = null;
        if (peek() === '=') { take(); init = expression(); }
        vars.push([name, init]);
        if (peek() !== ',') break;
        take();
      } while (true);
      return ['declare', vars, type];
    }
    const name = take(), op = take();
    assert.ok(['=', '+=', '*=', '++'].includes(op), 'supported statement operator: ' + op);
    return ['assign', name, op, op === '++' ? null : expression()];
  }
  function statement() {
    if (peek() === '{') {
      take(); const body = [];
      while (peek() !== '}') body.push(statement());
      take('}'); return ['block', body];
    }
    if (peek() === 'if') {
      take(); take('('); const cond = expression(); take(')');
      const yes = statement(); let no = null;
      if (peek() === 'else') { take(); no = statement(); }
      return ['if', cond, yes, no];
    }
    if (peek() === 'for') {
      take(); take('('); const init = simple(); take(';');
      const cond = expression(); take(';'); const step = simple(); take(')');
      return ['for', init, cond, step, statement()];
    }
    const result = simple(); take(';'); return result;
  }
  const body = [];
  while (pos < tokens.length) body.push(statement());
  return ['block', body];
}

function execute(ast, lumas, row, rowPixels = [f((row % 256) / 255), f(Math.floor(row / 256) / 255), 0, 1], variables = {}) {
  const env = { u_lut: 'LUT', u_classification: 'CLASSIFICATION', u_gradient_count: 9, coord_y: f((row + 0.5) / 288), base: [16, 16],
    angle: Math.floor(row / 12), strength: Math.floor(row % 12 / 3), coherence: row % 3, ...variables };
  const types = { base: 'ivec2', u_gradient_count: 'int' };
  lumas.forEach((value, i) => { env['luma' + i] = f(value); });
  const trace = [], samples = [], sourceSamples = [], accumulators = new Set(['res', 'lo', 'hi', 'lo2', 'hi2', 'abd']);
  const integer = node => node[0] === 'number' ? node[2] === true : node[0] === 'name' ? ['int', 'ivec2'].includes(types[node[1]]) :
    node[0] === 'binary' ? integer(node[2]) && integer(node[3]) : node[0] === 'swizzle' ? integer(node[1]) :
      node[0] === 'call' && ['int', 'ivec2', 'textureSize'].includes(node[1][1]);
  function evaluate(node) {
    const [kind, a, b, c] = node;
    if (kind === 'number') return f(a);
    if (kind === 'name') { assert.ok(a in env, 'initialized GLSL value: ' + a); return env[a]; }
    if (kind === 'index') { const array = evaluate(a), index = evaluate(b); assert.ok(index >= 0 && index < array.length, 'in-bounds GLSL array'); return array[index]; }
    if (kind === 'swizzle') {
      const value = evaluate(a), output = [...b].map(ch => value['xyzw'.includes(ch) ? 'xyzw'.indexOf(ch) : 'rgba'.indexOf(ch)]);
      return output.length === 1 ? output[0] : output;
    }
    if (kind === 'binary') {
      const x = evaluate(b), y = evaluate(c);
      if (a === '<') return x < y;
      if (a === '>=') return x >= y;
      if (a === '==') return x === y;
      if (a === '||') return x || y;
      return arithmetic(a, x, y, integer(b) && integer(c));
    }
    assert.equal(kind, 'call'); assert.equal(a[0], 'name');
    const args = b.map(evaluate), name = a[1];
    if (name === 'array') return args;
    if (name === 'vec2' || name === 'vec3' || name === 'vec4' || name === 'ivec2') return args.length === 1 ? Array(Number(name.slice(-1))).fill(args[0]) : args.flat();
    if (name === 'int') return Math.trunc(args[0]);
    if (name === 'floor') return Array.isArray(args[0]) ? args[0].map(Math.floor) : Math.floor(args[0]);
    if (name === 'round') return Array.isArray(args[0]) ? args[0].map(Math.round) : Math.round(args[0]);
    if (name === 'mod') return f(args[0] - args[1] * Math.floor(args[0] / args[1]));
    if (name === 'sqrt') return f(Math.sqrt(args[0]));
    if (name === 'abs') return f(Math.abs(args[0]));
    if (name === 'atan') return f(Math.atan2(args[0], args[1]));
    if (name === 'loadLuma') {
      const [x, y] = args[0].map(value => value - 16 + 2);
      assert.ok(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < 5 && y >= 0 && y < 5, 'same 5x5 source neighborhood');
      const index = x * 5 + y; sourceSamples.push(index); return f(lumas[index]);
    }
    if (name === 'textureSize') { assert.equal(args[0], 'LUT'); return [13, 288]; }
    if (name === 'texture') {
      assert.equal(args[0], 'LUT');
      const x = Math.max(0, Math.min(12, Math.floor(f(args[1][0] * 13)))), y = Math.max(0, Math.min(287, Math.floor(f(args[1][1] * 288))));
      assert.equal(y, row); samples.push(x);
      return lut.slice((y * 13 + x) * 4, (y * 13 + x + 1) * 4);
    }
    if (name === 'texelFetch') {
      if (args[0] === 'CLASSIFICATION') { assert.deepEqual(args[1], env.base); assert.equal(args[2], 0); return rowPixels; }
      assert.equal(args[0], 'LUT'); assert.equal(args[2], 0);
      const [x, y] = args[1]; assert.equal(y, row); assert.ok(x >= 0 && x < 13); samples.push(x);
      return lut.slice((y * 13 + x) * 4, (y * 13 + x + 1) * 4);
    }
    if (name === 'max') return lanes(args[0], args[1], Math.max);
    if (name === 'clamp') return lanes(lanes(args[0], args[1], Math.max), args[2], Math.min);
    if (name === 'mix') return typeof args[2] === 'boolean' ? args[2] ? args[1] : args[0] :
      arithmetic('+', arithmetic('*', args[0], arithmetic('-', 1, args[2])), arithmetic('*', args[1], args[2]));
    throw new Error('unsupported GLSL call: ' + name);
  }
  function run(node) {
    const [kind, a, b, c, d] = node;
    if (kind === 'block') { for (const child of a) run(child); return; }
    if (kind === 'declare') { for (const [name, init] of a) { types[name] = b; if (init) env[name] = evaluate(init); } return; }
    if (kind === 'if') { if (evaluate(a)) run(b); else if (c) run(c); return; }
    if (kind === 'for') {
      run(a); let limit = 0;
      while (evaluate(b)) { assert.ok(++limit <= 13, 'bounded RAVU loop'); run(d); run(c); }
      return;
    }
    assert.equal(kind, 'assign');
    env[a] = b === '=' ? evaluate(c) : b === '++' ? env[a] + 1 : arithmetic(b[0], env[a], evaluate(c));
    if (accumulators.has(a)) trace.push([a, Array.isArray(env[a]) ? [...env[a]] : env[a]]);
  }
  run(ast);
  return { result: env.res, trace, samples, sourceSamples, classification: env.outColor, decodedRow: env.lutRow,
    tensor:env.abd, angle:env.angle, strength:env.strength, coherence:env.coherence, expectedRow:env.expectedRow };
}

const observable = ({ result, trace, samples }) => ({ result, trace, samples });

const reference = parse(referenceText), optimized = parse(candidateText);
const encodeRow = parse(classifier.slice(classifier.indexOf('float classificationRow ='), classifier.lastIndexOf('}')));
let encodedCases = 0;
for (let row = 0; row < 288; row++) {
  const encoded = execute(encodeRow, [], row).classification;
  for (const format of ['rgba8', 'rgba16f']) {
    const stored = encoded.map(value => format === 'rgba8' ? f(Math.round(value * 255) / 255) : half.halfToFloat(half.floatToHalf(value)));
    const decoded = execute(optimized, Array(25).fill(.5), row, stored);
    assert.equal(decoded.decodedRow, row, 'lossless ' + format + ' two-byte classification row ' + row);
    encodedCases++;
  }
}
const flat = Array(25).fill(.5);
for (let strength = 0; strength < 4; strength++) for (let coherence = 0; coherence < 3; coherence++) {
  const raw = (24 * 4 + strength) * 3 + coherence;
  const encoded = execute(encodeRow, [], 287, undefined, { angle: 24, strength, coherence }).classification;
  for (const format of ['rgba8', 'rgba16f']) {
    const stored = encoded.map(value => format === 'rgba8' ? f(Math.round(value * 255) / 255) : half.halfToFloat(half.floatToHalf(value)));
    const decoded = execute(optimized, flat, 287, stored);
    assert.equal(decoded.decodedRow, 287, 'angle 24 preserves original upper CLAMP_TO_EDGE behavior');
    assert.deepEqual(observable(decoded), observable(execute(reference, flat, 287, undefined, { coord_y: f((raw + .5) / 288) })), 'same original clamped filter');
    encodedCases++;
  }
}
for (const [badBytes, expectedRow, raw] of [[[1, 1, 0, 1], 287, 65535], [[-1 / 255, 0, 0, 1], 0, -1]]) {
  const decoded = execute(optimized, flat, expectedRow, badBytes);
  assert.equal(decoded.decodedRow, expectedRow, 'invalid decoded row is clamped before texelFetch');
  assert.deepEqual(observable(decoded), observable(execute(reference, flat, expectedRow, undefined, { coord_y: f((raw + .5) / 288) })), 'defensive clamp matches original sampler edges');
}
let seed = 0x52a7c01;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0xffffffff; };
const patches = [Array(25).fill(0), Array(25).fill(1), Array(25).fill(0.5),
  Array.from({ length: 25 }, (_, i) => i / 24), Array.from({ length: 25 }, (_, i) => i % 2),
  Array.from({ length: 25 }, (_, i) => i === 12 ? 1 : 0),
  ...Array.from({ length: 12 }, () => Array.from({ length: 25 }, random))];
let cases = 0;
for (let row = 0; row < 288; row++) {
  for (const patch of patches) {
    const expected = execute(reference, patch, row), actual = execute(optimized, patch, row);
    assert.deepEqual(expected.samples, Array.from({ length: 13 }, (_, i) => i));
    assert.deepEqual(observable(actual), observable(expected), 'identical float32 samples, accumulator history and output at LUT row ' + row);
    assert.deepEqual(actual.sourceSamples, Array.from({ length: 13 }, (_, i) => i === 12 ? [12] : [i, 24 - i]).flat(), 'original tap order, mirrored source offsets, center fetched once');
    assert.ok(actual.result.every(Number.isFinite), 'finite RAVU output');
    cases++;
  }
}
// Prove the oracle is sensitive to mirror orientation and center double counting.
for (const [from, to] of [['base - offset', 'base + offset'], ['tap / 5 - 2, tap % 5 - 2', 'tap % 5 - 2, tap / 5 - 2'], ['if (tap == 12)', 'if (tap == 99)'],
  ['cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;', 'cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;cg4 *= cg4;']]) {
  assert.ok(candidateText.includes(from), 'mutation target exists');
  const mutant = execute(parse(candidateText.replaceAll(from, to)), patches[6], 73);
  assert.notDeepEqual(observable(mutant), observable(execute(reference, patches[6], 73)), 'oracle detects a changed shader operation');
}

// Execute the actual upstream 25-luma/nine-gradient body as the independent
// reference. The candidate refetches four neighboring lumas per gradient.
const originalClassifier = parse(upstreamClassBody + '\nint expectedRow = clamp(int(floor(coord_y * 288.0)), 0, 287);');
const classifierText = classifier.slice(classifier.indexOf('vec3 abd ='), classifier.lastIndexOf('}'));
const loopClassifier = parse(classifierText);
const gradientFetchOrder = [...upstreamClassBody.matchAll(/g[xy] = \(luma(\d+)-luma(\d+)\)\/2\.0;/g)]
  .flatMap(match => [Number(match[1]), Number(match[2])]);
assert.equal(gradientFetchOrder.length, 36, 'original nine gradients have four ordered luma operands each');
const classificationPatches = [...patches, ...Array.from({length:25}, (_, center) => Array.from({length:25}, (_, i) => i === center ? 1 : 0))];
for (const slope of [.004, .016, .05]) for (const side of [-1, 1]) for (const theta of [0, Math.PI / 24, Math.PI / 4]) {
  classificationPatches.push(Array.from({length:25}, (_, i) => .5 + slope * (1 + side * .001) *
    ((Math.floor(i / 5) - 2) * Math.cos(theta + side * 1e-5) + (i % 5 - 2) * Math.sin(theta + side * 1e-5))));
}
for (const mu of [.2499, .2501, .4999, .5001]) classificationPatches.push(Array.from({length:25}, (_, i) =>
  .5 + .1 * Math.sin(Math.floor(i / 5) * Math.PI / 2) + .1 * (1 - mu) / (1 + mu) * Math.sin((i % 5) * Math.PI / 2)));
for (let i = 0; i < 1024; i++) classificationPatches.push(Array.from({length:25}, random));
const classificationObservable = ({tensor,trace,angle,strength,coherence}) => ({tensor,trace,angle,strength,coherence});
for (const patch of classificationPatches) {
  const expected = execute(originalClassifier, patch, 0), actual = execute(loopClassifier, patch, 0);
  assert.deepEqual(classificationObservable(actual), classificationObservable(expected),
    'exact float32 tensor accumulator history, eigensystem and class decisions');
  assert.deepEqual(actual.sourceSamples, gradientFetchOrder, 'original X-major Gaussian gradient order and source axes');
  assert.equal(actual.trace.length,9,'exactly nine gradients contribute');
  const encoded = actual.classification;
  assert.equal(Math.round(encoded[0] * 255) + 256 * Math.round(encoded[1] * 255), expected.expectedRow,
    'encoded classifier selects the original nearest/clamped LUT row');
}
for (const [from,to] of [['gradient / 3 - 1, gradient % 3 - 1','gradient % 3 - 1, gradient / 3 - 1'],
  ['0.13080118386382833','0.11543163961422666']]) {
  assert.ok(classifierText.includes(from), 'classifier mutation target exists');
  assert.notDeepEqual(classificationObservable(execute(parse(classifierText.replace(from,to)), patches[6], 0)),
    classificationObservable(execute(originalClassifier, patches[6], 0)), 'oracle detects changed gradient order/weight');
}
console.log('PASS: RAVU dynamic loop matches upstream operation order and float32 output in ' + cases + ' cases; ' + encodedCases + ' lossless classification row encodings; mutation controls detected.');
console.log('PASS: ' + classificationPatches.length + ' exact upstream/classifier tensor and class comparisons, including threshold patches and mutation controls.');
