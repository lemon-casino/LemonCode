import assert from "node:assert/strict";
import { constants, createHash, generateKeyPairSync, privateEncrypt, verify } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const forge = require("node-forge");
const keys = generateKeyPairSync("rsa", { modulusLength: 1024 });
const publicKey = forge.pki.publicKeyFromPem(
  keys.publicKey.export({ type: "spki", format: "pem" }),
);
const message = Buffer.from("lcode dependency security fixture");
const digest = createHash("sha256").update(message).digest();
const asn1 = forge.asn1;

function signDigestInfo(parameters) {
  const algorithm = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(
      asn1.Class.UNIVERSAL,
      asn1.Type.OID,
      false,
      asn1.oidToDer(forge.oids.sha256).getBytes(),
    ),
    ...parameters,
  ]);
  const info = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    algorithm,
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, digest.toString("binary")),
  ]);
  return privateEncrypt(
    { key: keys.privateKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(asn1.toDer(info).getBytes(), "binary"),
  );
}

const nullParameter = () => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, "");

test("RSA verification preserves valid SHA-256 signatures with optional NULL parameters", () => {
  for (const parameters of [[], [nullParameter()]]) {
    const signature = signDigestInfo(parameters);
    assert.equal(publicKey.verify(digest.toString("binary"), signature.toString("binary")), true);
  }
});

for (const [name, parameters] of [
  ["extra NULL", [nullParameter(), nullParameter()]],
  [
    "extra nested sequence",
    [nullParameter(), asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [])],
  ],
  ["invalid optional parameter", [asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [])]],
  ["nonempty NULL", [asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, "garbage")]],
]) {
  test(`RSA verification rejects DigestAlgorithm ${name}`, () => {
    // 旧版只核对顶层元素数，嵌套 AlgorithmIdentifier 的多余字段会绕过可选 NULL 校验。
    // 用 Node/OpenSSL 验证作为独立参照，补丁必须同样拒绝该畸形签名。
    const signature = signDigestInfo(parameters);
    assert.equal(verify("sha256", message, keys.publicKey, signature), false);
    assert.throws(
      () => publicKey.verify(digest.toString("binary"), signature.toString("binary")),
      /DigestInfo/,
    );
  });
}
