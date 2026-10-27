// 临时测试：从用户脚本中提取 MD5/AES 实现并验证标准测试向量
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('C:/Users/Lenovo/Documents/deepseek-harness/default-workspace/video-bgm-swap/video-bgm-swap.user.js', 'utf8');

const startMarker = '// —— MD5（公共领域实现）——';
const endMarker = '// ==================== lx 宿主桥接（Sollin/LX 音源导入模式） ====================';
const start = src.indexOf(startMarker);
const end = src.indexOf(endMarker);
if (start < 0 || end < 0 || end <= start) {
  console.error('无法定位加密代码段');
  process.exit(1);
}
const cryptoCode = src.slice(start, end);

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(cryptoCode + `
globalThis.__test = {
  md5: md5,
  aesEncrypt: aesEncrypt,
  aesDecrypt: aesDecrypt,
  strToUtf8Bytes: strToUtf8Bytes,
  utf8BytesToStr: utf8BytesToStr
};
`, sandbox);

const t = sandbox.__test;

// MD5 测试向量
const md5Vectors = [
  ['', 'd41d8cd98f00b204e9800998ecf8427e'],
  ['abc', '900150983cd24fb0d6963f7d28e17f72'],
  ['The quick brown fox jumps over the lazy dog', '9e107d9d372bb6826bd81d3542a419d6'],
  ['中文测试', '2823bf6a1b8da48e7cb70bc2879b27bf']
];

let md5Ok = true;
for (const [input, expected] of md5Vectors) {
  const got = t.md5(input);
  const ok = got === expected;
  if (!ok) md5Ok = false;
  console.log(`md5(${JSON.stringify(input)}) = ${got} ${ok ? 'OK' : 'FAIL (期望 ' + expected + ')'}`);
}

// AES-128-ECB FIPS-197 测试向量
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
const plain = hexToBytes('00112233445566778899aabbccddeeff');
const cipherExpected = '69c4e0d86a7b0430d8cdb78070b4c55a';
// FIPS 密钥字节 00-0f 全部 <128，可直接用 fromCharCode 组成字符串（strToUtf8Bytes 会原样编码）
const fipsKeyStr = String.fromCharCode(...Array.from(hexToBytes('000102030405060708090a0b0c0d0e0f')));

const enc2 = t.aesEncrypt(plain, 'aes-128-ecb', fipsKeyStr, '');
const hex = Array.from(enc2).map(b => b.toString(16).padStart(2, '0')).join('');
// PKCS7：16字节输入会补成32字节，第一块应与 FIPS-197 向量一致
const firstBlock = hex.slice(0, 32);
const aesOk = firstBlock === cipherExpected;
console.log(`AES-128-ECB 第一块 = ${firstBlock} ${aesOk ? 'OK' : 'FAIL (期望 ' + cipherExpected + ')'}`);
console.log(`AES-128-ECB 全长   = ${hex}`);

const dec = t.aesDecrypt(enc2, 'aes-128-ecb', fipsKeyStr, '');
const decHex = Array.from(dec).map(b => b.toString(16).padStart(2, '0')).join('');
// pkcs7Unpad 已剥掉填充块，应正好还原出原文 16 字节
const decOk = decHex === '00112233445566778899aabbccddeeff';
console.log(`AES-128-ECB 解密还原 = ${decOk ? 'OK' : 'FAIL: ' + decHex}`);

// AES-128-CBC 往返（带 IV）
const iv = '000102030405060708090a0b0c0d0e0f';
const msg = 'hello world 你好，测试加密';
const encCbc = t.aesEncrypt(msg, 'aes-128-cbc', '000102030405060708090a0b0c0d0e0f', iv);
const decCbc = t.aesDecrypt(encCbc, 'aes-128-cbc', '000102030405060708090a0b0c0d0e0f', iv);
const decCbcStr = t.utf8BytesToStr(Array.from(decCbc));
const cbcOk = decCbcStr === msg;
console.log(`AES-128-CBC 字符串往返 = ${cbcOk ? 'OK' : 'FAIL: ' + decCbcStr}`);

process.exit(md5Ok && aesOk && decOk && cbcOk ? 0 : 1);