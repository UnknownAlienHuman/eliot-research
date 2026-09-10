//! Bounded JSON frame parser for `scope-snapshot-identity.v1`.
//!
//! The parser admits explicit bytes only: duplicate member names, invalid UTF-8,
//! non-canonical numeric forms, invalid Unicode scalar sequences and every
//! configured overflow fail with a content-free typed error.

#![forbid(unsafe_code)]

use std::collections::BTreeSet;

use super::error::SnapshotIdentityError;
use super::{
    SNAPSHOT_ARRAY_ITEMS_MAX, SNAPSHOT_INPUT_MAX_BYTES, SNAPSHOT_NODES_MAX,
    SNAPSHOT_OBJECT_MEMBERS_MAX, SNAPSHOT_PARSER_DEPTH_MAX, SNAPSHOT_PARSER_STEPS_MAX,
    SNAPSHOT_SAFE_INTEGER_MAX, SNAPSHOT_STRING_MAX_BYTES,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Value {
    Null,
    Boolean(bool),
    Integer(i64),
    String(String),
    Array(Vec<Self>),
    Object(Vec<(String, Self)>),
}

impl Value {
    pub(crate) fn as_object(&self) -> Option<&[(String, Self)]> {
        match self {
            Self::Object(m) => Some(m),
            _ => None,
        }
    }
    pub(crate) fn as_array(&self) -> Option<&[Self]> {
        match self {
            Self::Array(v) => Some(v),
            _ => None,
        }
    }
    pub(crate) fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(s) => Some(s),
            _ => None,
        }
    }
    pub(crate) fn as_integer(&self) -> Option<i64> {
        match self {
            Self::Integer(n) => Some(*n),
            _ => None,
        }
    }
}

pub(crate) fn field<'a>(members: &'a [(String, Value)], key: &str) -> Option<&'a Value> {
    members
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value)
}

struct FrameParser<'a> {
    input: &'a [u8],
    cursor: usize,
    nodes: usize,
}

pub(crate) fn parse_frame(input: &[u8]) -> Result<Value, SnapshotIdentityError> {
    if input.len() > SNAPSHOT_INPUT_MAX_BYTES {
        return Err(SnapshotIdentityError::InputTooLarge {
            actual_bytes: input.len(),
            max_bytes: SNAPSHOT_INPUT_MAX_BYTES,
        });
    }
    core::str::from_utf8(input).map_err(|e| SnapshotIdentityError::InvalidUtf8 {
        valid_up_to: e.valid_up_to(),
    })?;
    let mut parser = FrameParser {
        input,
        cursor: 0,
        nodes: 0,
    };
    parser.skip_ws()?;
    let value = parser.parse_value(0)?;
    parser.skip_ws()?;
    if parser.cursor != input.len() {
        return Err(SnapshotIdentityError::Syntax {
            offset: parser.cursor,
        });
    }
    Ok(value)
}

impl FrameParser<'_> {
    fn parse_value(&mut self, depth: usize) -> Result<Value, SnapshotIdentityError> {
        if self.nodes >= SNAPSHOT_NODES_MAX {
            return Err(SnapshotIdentityError::NodeLimit {
                max_nodes: SNAPSHOT_NODES_MAX,
            });
        }
        self.nodes += 1;
        match self.peek() {
            Some(b'n') => self.literal(b"null", Value::Null),
            Some(b't') => self.literal(b"true", Value::Boolean(true)),
            Some(b'f') => self.literal(b"false", Value::Boolean(false)),
            Some(b'"') => self.parse_string().map(Value::String),
            Some(b'[') => self.parse_array(depth),
            Some(b'{') => self.parse_object(depth),
            Some(b'-' | b'0'..=b'9') => self.parse_integer().map(Value::Integer),
            _ => Err(self.syntax()),
        }
    }
    fn literal(&mut self, literal: &[u8], value: Value) -> Result<Value, SnapshotIdentityError> {
        let end = self.cursor.saturating_add(literal.len());
        if self.input.get(self.cursor..end) != Some(literal) {
            return Err(self.syntax());
        }
        self.cursor = end;
        Ok(value)
    }
    fn parse_array(&mut self, depth: usize) -> Result<Value, SnapshotIdentityError> {
        self.enter(depth)?;
        self.cursor += 1;
        self.skip_ws()?;
        let mut values = Vec::new();
        if self.eat(b']') {
            return Ok(Value::Array(values));
        }
        loop {
            if values.len() >= SNAPSHOT_ARRAY_ITEMS_MAX {
                return Err(SnapshotIdentityError::MemberLimit {
                    max_members: SNAPSHOT_ARRAY_ITEMS_MAX,
                });
            }
            values.push(self.parse_value(depth + 1)?);
            self.skip_ws()?;
            if self.eat(b']') {
                break;
            }
            if !self.eat(b',') {
                return Err(self.syntax());
            }
            self.skip_ws()?;
        }
        Ok(Value::Array(values))
    }
    fn parse_object(&mut self, depth: usize) -> Result<Value, SnapshotIdentityError> {
        self.enter(depth)?;
        self.cursor += 1;
        self.skip_ws()?;
        let mut members = Vec::new();
        let mut keys = BTreeSet::new();
        if self.eat(b'}') {
            return Ok(Value::Object(members));
        }
        loop {
            if members.len() >= SNAPSHOT_OBJECT_MEMBERS_MAX {
                return Err(SnapshotIdentityError::MemberLimit {
                    max_members: SNAPSHOT_OBJECT_MEMBERS_MAX,
                });
            }
            let key_offset = self.cursor;
            if self.peek() != Some(b'"') {
                return Err(self.syntax());
            }
            let key = self.parse_string()?;
            if !keys.insert(key.clone()) {
                return Err(SnapshotIdentityError::DuplicateKey { offset: key_offset });
            }
            self.skip_ws()?;
            if !self.eat(b':') {
                return Err(self.syntax());
            }
            self.skip_ws()?;
            let value = self.parse_value(depth + 1)?;
            members.push((key, value));
            self.skip_ws()?;
            if self.eat(b'}') {
                break;
            }
            if !self.eat(b',') {
                return Err(self.syntax());
            }
            self.skip_ws()?;
        }
        members.sort_by(|a, b| super::emit::compare_utf16(a.0.as_str(), b.0.as_str()));
        Ok(Value::Object(members))
    }
    fn enter(&self, depth: usize) -> Result<(), SnapshotIdentityError> {
        if depth >= SNAPSHOT_PARSER_DEPTH_MAX {
            return Err(SnapshotIdentityError::DepthLimit {
                max_depth: SNAPSHOT_PARSER_DEPTH_MAX,
            });
        }
        Ok(())
    }
    fn parse_integer(&mut self) -> Result<i64, SnapshotIdentityError> {
        let start = self.cursor;
        let negative = self.eat(b'-');
        let digits_start = self.cursor;
        match self.peek() {
            Some(b'0') => {
                self.cursor += 1;
                if matches!(self.peek(), Some(b'0'..=b'9')) {
                    return Err(SnapshotIdentityError::Number { offset: start });
                }
            }
            Some(b'1'..=b'9') => {
                self.cursor += 1;
                // S5 bounded-iteration guard: a `+=`→`*=` mutant would stall `cursor`.
                let mut iterations = 0_usize;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    if iterations >= SNAPSHOT_PARSER_STEPS_MAX {
                        return Err(self.syntax());
                    }
                    iterations += 1;
                    self.cursor += 1;
                }
            }
            _ => return Err(SnapshotIdentityError::Number { offset: start }),
        }
        if matches!(self.peek(), Some(b'.' | b'e' | b'E')) {
            return Err(SnapshotIdentityError::Number { offset: start });
        }
        let mut magnitude = 0_i64;
        let raw = self
            .input
            .get(digits_start..self.cursor)
            .ok_or(SnapshotIdentityError::Number { offset: start })?;
        for byte in raw {
            let digit = i64::from(*byte - b'0');
            if magnitude > (SNAPSHOT_SAFE_INTEGER_MAX - digit) / 10 {
                return Err(SnapshotIdentityError::Number { offset: start });
            }
            magnitude = magnitude * 10 + digit;
        }
        if negative && magnitude == 0 {
            return Err(SnapshotIdentityError::Number { offset: start });
        }
        Ok(if negative { -magnitude } else { magnitude })
    }
    fn parse_string(&mut self) -> Result<String, SnapshotIdentityError> {
        let start = self.cursor;
        if !self.eat(b'"') {
            return Err(self.syntax());
        }
        let mut out = Vec::new();
        // S5 bounded-iteration guard: every iteration must consume input.
        // Covers `+=`→`*=` stalls and `utf8_width`→`Some(0)` zero-progress.
        let mut iterations = 0_usize;
        loop {
            if iterations >= SNAPSHOT_PARSER_STEPS_MAX {
                return Err(self.syntax());
            }
            iterations += 1;
            let Some(byte) = self.peek() else {
                return Err(SnapshotIdentityError::Syntax { offset: start });
            };
            match byte {
                b'"' => {
                    self.cursor += 1;
                    return String::from_utf8(out)
                        .map_err(|_| SnapshotIdentityError::Unicode { offset: start });
                }
                b'\\' => {
                    self.cursor += 1;
                    self.escape(&mut out)?;
                }
                0x00..=0x1f => return Err(self.syntax()),
                0x20..=0x7f => {
                    self.cursor += 1;
                    push_str_byte(&mut out, &[byte])?;
                }
                _ => {
                    let Some(width) = utf8_width(byte) else {
                        return Err(SnapshotIdentityError::Unicode {
                            offset: self.cursor,
                        });
                    };
                    let end = self.cursor.saturating_add(width);
                    let Some(bytes) = self.input.get(self.cursor..end) else {
                        return Err(SnapshotIdentityError::Unicode {
                            offset: self.cursor,
                        });
                    };
                    push_str_byte(&mut out, bytes)?;
                    self.cursor = end;
                }
            }
        }
    }
    fn escape(&mut self, out: &mut Vec<u8>) -> Result<(), SnapshotIdentityError> {
        let offset = self.cursor.saturating_sub(1);
        let Some(esc) = self.peek() else {
            return Err(SnapshotIdentityError::Syntax { offset });
        };
        self.cursor += 1;
        match esc {
            b'"' => push_str_byte(out, b"\""),
            b'\\' => push_str_byte(out, b"\\"),
            b'/' => push_str_byte(out, b"/"),
            b'b' => push_str_byte(out, &[0x08]),
            b'f' => push_str_byte(out, &[0x0c]),
            b'n' => push_str_byte(out, b"\n"),
            b'r' => push_str_byte(out, b"\r"),
            b't' => push_str_byte(out, b"\t"),
            b'u' => self.unicode_escape(out, offset),
            _ => Err(SnapshotIdentityError::Syntax { offset }),
        }
    }
    fn unicode_escape(
        &mut self,
        out: &mut Vec<u8>,
        offset: usize,
    ) -> Result<(), SnapshotIdentityError> {
        let first = self.hex_quad(offset)?;
        let scalar = if (0xd800..=0xdbff).contains(&first) {
            if self.input.get(self.cursor..self.cursor.saturating_add(2)) != Some(b"\\u") {
                return Err(SnapshotIdentityError::Unicode { offset });
            }
            self.cursor += 2;
            let second = self.hex_quad(offset)?;
            if !(0xdc00..=0xdfff).contains(&second) {
                return Err(SnapshotIdentityError::Unicode { offset });
            }
            0x1_0000 + ((u32::from(first) - 0xd800) << 10) + (u32::from(second) - 0xdc00)
        } else if (0xdc00..=0xdfff).contains(&first) {
            return Err(SnapshotIdentityError::Unicode { offset });
        } else {
            u32::from(first)
        };
        let Some(ch) = char::from_u32(scalar) else {
            return Err(SnapshotIdentityError::Unicode { offset });
        };
        let mut encoded = [0_u8; 4];
        push_str_byte(out, ch.encode_utf8(&mut encoded).as_bytes())
    }
    fn hex_quad(&mut self, offset: usize) -> Result<u16, SnapshotIdentityError> {
        let end = self.cursor.saturating_add(4);
        let Some(bytes) = self.input.get(self.cursor..end) else {
            return Err(SnapshotIdentityError::Unicode { offset });
        };
        let mut value = 0_u16;
        for byte in bytes {
            let Some(nibble) = hex_nibble(*byte) else {
                return Err(SnapshotIdentityError::Unicode { offset });
            };
            value = (value << 4) | u16::from(nibble);
        }
        self.cursor = end;
        Ok(value)
    }
    fn skip_ws(&mut self) -> Result<(), SnapshotIdentityError> {
        // S5 bounded-iteration guard: each iteration must advance `cursor`.
        // A `+=`→`*=` mutant would otherwise spin forever on `cursor == 0`.
        let mut iterations = 0_usize;
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            if iterations >= SNAPSHOT_PARSER_STEPS_MAX {
                return Err(self.syntax());
            }
            iterations += 1;
            self.cursor += 1;
        }
        Ok(())
    }
    fn eat(&mut self, expected: u8) -> bool {
        if self.peek() == Some(expected) {
            self.cursor += 1;
            true
        } else {
            false
        }
    }
    fn peek(&self) -> Option<u8> {
        self.input.get(self.cursor).copied()
    }
    const fn syntax(&self) -> SnapshotIdentityError {
        SnapshotIdentityError::Syntax {
            offset: self.cursor,
        }
    }
}

pub(crate) fn push_str_byte(out: &mut Vec<u8>, bytes: &[u8]) -> Result<(), SnapshotIdentityError> {
    if out.len().saturating_add(bytes.len()) > SNAPSHOT_STRING_MAX_BYTES {
        return Err(SnapshotIdentityError::StringTooLarge {
            max_bytes: SNAPSHOT_STRING_MAX_BYTES,
        });
    }
    out.extend_from_slice(bytes);
    Ok(())
}

const fn utf8_width(byte: u8) -> Option<usize> {
    match byte {
        0xc2..=0xdf => Some(2),
        0xe0..=0xef => Some(3),
        0xf0..=0xf4 => Some(4),
        _ => None,
    }
}

const fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
