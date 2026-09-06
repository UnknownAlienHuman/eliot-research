import { ARRAY_ITEMS_MAX, CODES, NODES_MAX, OBJECT_MEMBERS_MAX, PARSER_DEPTH_MAX, SAFE_INTEGER_MAX, STRING_MAX_BYTES, encoder } from "./constants.mjs";
import { raise } from "./canonical.mjs";

export class FrameParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
    this.nodes = 0;
  }

  parse() {
    this.skipWs();
    const value = this.parseValue(0);
    this.skipWs();
    if (this.index !== this.source.length) raise(CODES.syntax);
    return value;
  }

  parseValue(depth) {
    this.nodes += 1;
    if (this.nodes > NODES_MAX) raise(CODES.nodeLimit);
    const ch = this.peek();
    if (ch === "n") return this.literal("null", null);
    if (ch === "t") return this.literal("true", true);
    if (ch === "f") return this.literal("false", false);
    if (ch === '"') return this.parseString();
    if (ch === "[") return this.parseArray(depth);
    if (ch === "{") return this.parseObject(depth);
    if (ch === "-" || (ch >= "0" && ch <= "9")) return this.parseInteger();
    raise(CODES.syntax);
  }

  literal(token, value) {
    if (this.source.startsWith(token, this.index)) {
      this.index += token.length;
      return value;
    }
    raise(CODES.syntax);
  }

  parseArray(depth) {
    this.enter(depth);
    this.index += 1;
    this.skipWs();
    const values = [];
    if (this.eat("]")) return values;
    for (;;) {
      if (values.length >= ARRAY_ITEMS_MAX) raise(CODES.memberLimit);
      values.push(this.parseValue(depth + 1));
      this.skipWs();
      if (this.eat("]")) return values;
      if (!this.eat(",")) raise(CODES.syntax);
      this.skipWs();
    }
  }

  parseObject(depth) {
    this.enter(depth);
    this.index += 1;
    this.skipWs();
    const members = new Map();
    if (this.eat("}")) return members;
    for (;;) {
      if (members.size >= OBJECT_MEMBERS_MAX) raise(CODES.memberLimit);
      if (this.peek() !== '"') raise(CODES.syntax);
      const key = this.parseString();
      if (members.has(key)) raise(CODES.duplicateKey);
      this.skipWs();
      if (!this.eat(":")) raise(CODES.syntax);
      this.skipWs();
      members.set(key, this.parseValue(depth + 1));
      this.skipWs();
      if (this.eat("}")) return members;
      if (!this.eat(",")) raise(CODES.syntax);
      this.skipWs();
    }
  }

  enter(depth) {
    if (depth >= PARSER_DEPTH_MAX) raise(CODES.depthLimit);
  }

  parseInteger() {
    const start = this.index;
    let negative = false;
    if (this.eat("-")) negative = true;
    const digitsStart = this.index;
    if (this.peek() === "0") {
      this.index += 1;
      const next = this.peek();
      if (next >= "0" && next <= "9") raise(CODES.number);
    } else if (this.peek() >= "1" && this.peek() <= "9") {
      this.index += 1;
      while (this.peek() >= "0" && this.peek() <= "9") this.index += 1;
    } else {
      raise(CODES.number);
    }
    if ([".", "e", "E"].includes(this.peek())) raise(CODES.number);
    const token = this.source.slice(digitsStart, this.index);
    let magnitude = 0;
    for (const ch of token) {
      magnitude = magnitude * 10 + (ch.charCodeAt(0) - 0x30);
      if (magnitude > SAFE_INTEGER_MAX) raise(CODES.number);
    }
    if (negative && magnitude === 0) raise(CODES.number);
    void start;
    return negative ? -magnitude : magnitude;
  }

  parseString() {
    if (!this.eat('"')) raise(CODES.syntax);
    let out = "";
    for (;;) {
      if (this.index >= this.source.length) raise(CODES.syntax);
      const code = this.source.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        if (encoder.encode(out).byteLength > STRING_MAX_BYTES) raise(CODES.stringTooLarge);
        return out;
      }
      if (code === 0x5c) {
        this.index += 1;
        out += this.parseEscape();
        continue;
      }
      if (code < 0x20) raise(CODES.syntax);
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = this.source.charCodeAt(this.index + 1);
        if (!(low >= 0xdc00 && low <= 0xdfff)) raise(CODES.unicode);
        out += this.source.slice(this.index, this.index + 2);
        this.index += 2;
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) raise(CODES.unicode);
      out += this.source[this.index];
      this.index += 1;
    }
  }

  parseEscape() {
    if (this.index >= this.source.length) raise(CODES.syntax);
    const esc = this.source[this.index];
    this.index += 1;
    const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
    if (Object.hasOwn(simple, esc)) return simple[esc];
    if (esc !== "u") raise(CODES.syntax);
    const first = this.hexQuad();
    if (first >= 0xd800 && first <= 0xdbff) {
      if (this.source.slice(this.index, this.index + 2) !== "\\u") raise(CODES.unicode);
      this.index += 2;
      const second = this.hexQuad();
      if (second < 0xdc00 || second > 0xdfff) raise(CODES.unicode);
      return String.fromCodePoint(0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00));
    }
    if (first >= 0xdc00 && first <= 0xdfff) raise(CODES.unicode);
    return String.fromCodePoint(first);
  }

  hexQuad() {
    const token = this.source.slice(this.index, this.index + 4);
    if (!/^[0-9A-Fa-f]{4}$/u.test(token)) raise(CODES.unicode);
    this.index += 4;
    return Number.parseInt(token, 16);
  }

  skipWs() {
    while ([" ", "\n", "\r", "\t"].includes(this.peek())) this.index += 1;
  }

  eat(ch) {
    if (this.source[this.index] !== ch) return false;
    this.index += 1;
    return true;
  }

  peek() {
    if (this.index >= this.source.length) return "";
    return this.source[this.index];
  }
}
