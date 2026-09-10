//! Bounded, dependency-free canonical JSON for the M2 differential shadow kernel.
//!
//! This module intentionally defines a narrow product-neutral value model. It accepts JSON null,
//! booleans, strings, arrays, objects, and canonical safe integers. Floating-point and exponent forms
//! remain outside the M2 `canonical-body.v1` family.

#![forbid(unsafe_code)]

use core::cmp::Ordering;
use std::collections::BTreeSet;

use crate::canonical_json_error::{
    CanonicalJsonError, MAX_CANONICAL_JSON_ARRAY_ITEMS, MAX_CANONICAL_JSON_DEPTH,
    MAX_CANONICAL_JSON_INPUT_BYTES, MAX_CANONICAL_JSON_INTEGER, MAX_CANONICAL_JSON_NODES,
    MAX_CANONICAL_JSON_OBJECT_MEMBERS, MAX_CANONICAL_JSON_OUTPUT_BYTES,
    MAX_CANONICAL_JSON_STRING_BYTES,
};

#[derive(Debug, Clone, PartialEq, Eq)]
enum JsonValue {
    Null,
    Boolean(bool),
    Integer(i64),
    String(String),
    Array(Vec<Self>),
    Object(Vec<(String, Self)>),
}

/// Parses and emits the bounded `canonical-body.v1` JSON representation.
///
/// Object keys are sorted by decoded UTF-16 code units, matching the current TypeScript `Array.sort()` authority. Strings use minimal JSON escaping, arrays retain
/// order, whitespace is removed, and integers are emitted in canonical decimal form.
///
/// # Errors
///
/// Returns a typed, source-content-free error for malformed input or any explicit resource overflow.
pub fn canonicalize_json(input: &[u8]) -> Result<Vec<u8>, CanonicalJsonError> {
    if input.len() > MAX_CANONICAL_JSON_INPUT_BYTES {
        return Err(CanonicalJsonError::InputTooLarge {
            actual_bytes: input.len(),
            max_bytes: MAX_CANONICAL_JSON_INPUT_BYTES,
        });
    }
    core::str::from_utf8(input).map_err(|error| CanonicalJsonError::InvalidUtf8 {
        valid_up_to: error.valid_up_to(),
    })?;

    let value = Parser::new(input).parse()?;
    let mut writer = CanonicalWriter::new(input.len());
    writer.write_value(&value)?;
    Ok(writer.finish())
}

struct Parser<'a> {
    input: &'a [u8],
    cursor: usize,
    nodes: usize,
}

impl<'a> Parser<'a> {
    const fn new(input: &'a [u8]) -> Self {
        Self {
            input,
            cursor: 0,
            nodes: 0,
        }
    }

    fn parse(mut self) -> Result<JsonValue, CanonicalJsonError> {
        self.skip_whitespace();
        let value = self.parse_value(0)?;
        self.skip_whitespace();
        if self.cursor != self.input.len() {
            return Err(self.syntax());
        }
        Ok(value)
    }

    fn parse_value(&mut self, depth: usize) -> Result<JsonValue, CanonicalJsonError> {
        self.register_node()?;
        match self.peek() {
            Some(b'n') => self.parse_literal(b"null", JsonValue::Null),
            Some(b't') => self.parse_literal(b"true", JsonValue::Boolean(true)),
            Some(b'f') => self.parse_literal(b"false", JsonValue::Boolean(false)),
            Some(b'"') => self.parse_string().map(JsonValue::String),
            Some(b'[') => self.parse_array(depth),
            Some(b'{') => self.parse_object(depth),
            Some(b'-' | b'0'..=b'9') => self.parse_integer().map(JsonValue::Integer),
            _ => Err(self.syntax()),
        }
    }

    fn register_node(&mut self) -> Result<(), CanonicalJsonError> {
        if self.nodes == MAX_CANONICAL_JSON_NODES {
            return Err(CanonicalJsonError::NodeLimit {
                max_nodes: MAX_CANONICAL_JSON_NODES,
            });
        }
        self.nodes += 1;
        Ok(())
    }

    fn parse_literal(
        &mut self,
        literal: &[u8],
        value: JsonValue,
    ) -> Result<JsonValue, CanonicalJsonError> {
        let end = self.cursor.saturating_add(literal.len());
        if self.input.get(self.cursor..end) != Some(literal) {
            return Err(self.syntax());
        }
        self.cursor = end;
        Ok(value)
    }

    fn parse_array(&mut self, depth: usize) -> Result<JsonValue, CanonicalJsonError> {
        self.enter_container(depth)?;
        self.cursor += 1;
        self.skip_whitespace();
        let mut values = Vec::new();
        if self.consume_if(b']') {
            return Ok(JsonValue::Array(values));
        }

        loop {
            if values.len() == MAX_CANONICAL_JSON_ARRAY_ITEMS {
                return Err(CanonicalJsonError::ItemLimit {
                    max_items: MAX_CANONICAL_JSON_ARRAY_ITEMS,
                });
            }
            values.push(self.parse_value(depth + 1)?);
            self.skip_whitespace();
            if self.consume_if(b']') {
                break;
            }
            if !self.consume_if(b',') {
                return Err(self.syntax());
            }
            self.skip_whitespace();
        }
        Ok(JsonValue::Array(values))
    }

    fn parse_object(&mut self, depth: usize) -> Result<JsonValue, CanonicalJsonError> {
        self.enter_container(depth)?;
        self.cursor += 1;
        self.skip_whitespace();
        let mut members = Vec::new();
        let mut keys = BTreeSet::new();
        if self.consume_if(b'}') {
            return Ok(JsonValue::Object(members));
        }

        loop {
            if members.len() == MAX_CANONICAL_JSON_OBJECT_MEMBERS {
                return Err(CanonicalJsonError::MemberLimit {
                    max_members: MAX_CANONICAL_JSON_OBJECT_MEMBERS,
                });
            }
            let key_offset = self.cursor;
            if self.peek() != Some(b'"') {
                return Err(self.syntax());
            }
            let key = self.parse_string()?;
            if !keys.insert(key.clone()) {
                return Err(CanonicalJsonError::DuplicateKey { offset: key_offset });
            }
            self.skip_whitespace();
            if !self.consume_if(b':') {
                return Err(self.syntax());
            }
            self.skip_whitespace();
            let value = self.parse_value(depth + 1)?;
            members.push((key, value));
            self.skip_whitespace();
            if self.consume_if(b'}') {
                break;
            }
            if !self.consume_if(b',') {
                return Err(self.syntax());
            }
            self.skip_whitespace();
        }

        members.sort_by(|left, right| compare_utf16_code_units(&left.0, &right.0));
        Ok(JsonValue::Object(members))
    }

    fn enter_container(&self, depth: usize) -> Result<(), CanonicalJsonError> {
        if depth >= MAX_CANONICAL_JSON_DEPTH {
            return Err(CanonicalJsonError::DepthLimit {
                max_depth: MAX_CANONICAL_JSON_DEPTH,
            });
        }
        Ok(())
    }

    fn parse_integer(&mut self) -> Result<i64, CanonicalJsonError> {
        let start = self.cursor;
        let negative = self.consume_if(b'-');
        let digits_start = self.cursor;
        match self.peek() {
            Some(b'0') => {
                self.cursor += 1;
                if matches!(self.peek(), Some(b'0'..=b'9')) {
                    return Err(CanonicalJsonError::Number { offset: start });
                }
            }
            Some(b'1'..=b'9') => {
                self.cursor += 1;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.cursor += 1;
                }
            }
            _ => return Err(CanonicalJsonError::Number { offset: start }),
        }
        if matches!(self.peek(), Some(b'.' | b'e' | b'E')) {
            return Err(CanonicalJsonError::Number { offset: start });
        }

        let mut magnitude = 0_i64;
        for byte in &self.input[digits_start..self.cursor] {
            let digit = i64::from(*byte - b'0');
            if magnitude > (MAX_CANONICAL_JSON_INTEGER - digit) / 10 {
                return Err(CanonicalJsonError::Number { offset: start });
            }
            magnitude = magnitude * 10 + digit;
        }
        if negative && magnitude == 0 {
            return Err(CanonicalJsonError::Number { offset: start });
        }
        Ok(if negative { -magnitude } else { magnitude })
    }

    fn parse_string(&mut self) -> Result<String, CanonicalJsonError> {
        let start = self.cursor;
        if !self.consume_if(b'"') {
            return Err(self.syntax());
        }
        let mut output = Vec::new();

        loop {
            let Some(byte) = self.peek() else {
                return Err(CanonicalJsonError::Syntax { offset: start });
            };
            match byte {
                b'"' => {
                    self.cursor += 1;
                    return String::from_utf8(output)
                        .map_err(|_error| CanonicalJsonError::Unicode { offset: start });
                }
                b'\\' => {
                    self.cursor += 1;
                    self.parse_escape(&mut output)?;
                }
                0x00..=0x1f => return Err(self.syntax()),
                0x20..=0x7f => {
                    self.cursor += 1;
                    append_string_bytes(&mut output, &[byte])?;
                }
                _ => {
                    let Some(width) = utf8_width(byte) else {
                        return Err(CanonicalJsonError::Unicode {
                            offset: self.cursor,
                        });
                    };
                    let end = self.cursor.saturating_add(width);
                    let Some(bytes) = self.input.get(self.cursor..end) else {
                        return Err(CanonicalJsonError::Unicode {
                            offset: self.cursor,
                        });
                    };
                    append_string_bytes(&mut output, bytes)?;
                    self.cursor = end;
                }
            }
        }
    }

    fn parse_escape(&mut self, output: &mut Vec<u8>) -> Result<(), CanonicalJsonError> {
        let offset = self.cursor.saturating_sub(1);
        let Some(escape) = self.peek() else {
            return Err(CanonicalJsonError::Syntax { offset });
        };
        self.cursor += 1;
        match escape {
            b'"' => append_string_bytes(output, b"\""),
            b'\\' => append_string_bytes(output, b"\\"),
            b'/' => append_string_bytes(output, b"/"),
            b'b' => append_string_bytes(output, &[0x08]),
            b'f' => append_string_bytes(output, &[0x0c]),
            b'n' => append_string_bytes(output, b"\n"),
            b'r' => append_string_bytes(output, b"\r"),
            b't' => append_string_bytes(output, b"\t"),
            b'u' => self.parse_unicode_escape(output, offset),
            _ => Err(CanonicalJsonError::Syntax { offset }),
        }
    }

    fn parse_unicode_escape(
        &mut self,
        output: &mut Vec<u8>,
        offset: usize,
    ) -> Result<(), CanonicalJsonError> {
        let first = self.parse_hex_quad(offset)?;
        let scalar = if (0xd800..=0xdbff).contains(&first) {
            if self.input.get(self.cursor..self.cursor.saturating_add(2)) != Some(b"\\u") {
                return Err(CanonicalJsonError::Unicode { offset });
            }
            self.cursor += 2;
            let second = self.parse_hex_quad(offset)?;
            if !(0xdc00..=0xdfff).contains(&second) {
                return Err(CanonicalJsonError::Unicode { offset });
            }
            0x1_0000 + ((u32::from(first) - 0xd800) << 10) + (u32::from(second) - 0xdc00)
        } else if (0xdc00..=0xdfff).contains(&first) {
            return Err(CanonicalJsonError::Unicode { offset });
        } else {
            u32::from(first)
        };

        let Some(character) = char::from_u32(scalar) else {
            return Err(CanonicalJsonError::Unicode { offset });
        };
        let mut encoded = [0_u8; 4];
        append_string_bytes(output, character.encode_utf8(&mut encoded).as_bytes())
    }

    fn parse_hex_quad(&mut self, offset: usize) -> Result<u16, CanonicalJsonError> {
        let end = self.cursor.saturating_add(4);
        let Some(bytes) = self.input.get(self.cursor..end) else {
            return Err(CanonicalJsonError::Unicode { offset });
        };
        let mut value = 0_u16;
        for byte in bytes {
            let Some(nibble) = hex_nibble(*byte) else {
                return Err(CanonicalJsonError::Unicode { offset });
            };
            value = (value << 4) | u16::from(nibble);
        }
        self.cursor = end;
        Ok(value)
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.cursor += 1;
        }
    }

    fn consume_if(&mut self, expected: u8) -> bool {
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

    const fn syntax(&self) -> CanonicalJsonError {
        CanonicalJsonError::Syntax {
            offset: self.cursor,
        }
    }
}

fn compare_utf16_code_units(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn append_string_bytes(output: &mut Vec<u8>, bytes: &[u8]) -> Result<(), CanonicalJsonError> {
    let Some(next_len) = output.len().checked_add(bytes.len()) else {
        return Err(CanonicalJsonError::StringTooLarge {
            max_bytes: MAX_CANONICAL_JSON_STRING_BYTES,
        });
    };
    if next_len > MAX_CANONICAL_JSON_STRING_BYTES {
        return Err(CanonicalJsonError::StringTooLarge {
            max_bytes: MAX_CANONICAL_JSON_STRING_BYTES,
        });
    }
    output.extend_from_slice(bytes);
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

struct CanonicalWriter {
    output: Vec<u8>,
}

impl CanonicalWriter {
    fn new(input_len: usize) -> Self {
        Self {
            output: Vec::with_capacity(input_len.min(MAX_CANONICAL_JSON_OUTPUT_BYTES)),
        }
    }

    fn finish(self) -> Vec<u8> {
        self.output
    }

    fn write_value(&mut self, value: &JsonValue) -> Result<(), CanonicalJsonError> {
        match value {
            JsonValue::Null => self.push_bytes(b"null"),
            JsonValue::Boolean(true) => self.push_bytes(b"true"),
            JsonValue::Boolean(false) => self.push_bytes(b"false"),
            JsonValue::Integer(integer) => self.push_bytes(integer.to_string().as_bytes()),
            JsonValue::String(string) => self.write_string(string),
            JsonValue::Array(values) => {
                self.push_byte(b'[')?;
                for (index, item) in values.iter().enumerate() {
                    if index > 0 {
                        self.push_byte(b',')?;
                    }
                    self.write_value(item)?;
                }
                self.push_byte(b']')
            }
            JsonValue::Object(members) => {
                self.push_byte(b'{')?;
                for (index, (key, member)) in members.iter().enumerate() {
                    if index > 0 {
                        self.push_byte(b',')?;
                    }
                    self.write_string(key)?;
                    self.push_byte(b':')?;
                    self.write_value(member)?;
                }
                self.push_byte(b'}')
            }
        }
    }

    fn write_string(&mut self, value: &str) -> Result<(), CanonicalJsonError> {
        self.push_byte(b'"')?;
        for byte in value.as_bytes() {
            match *byte {
                b'"' => self.push_bytes(b"\\\""),
                b'\\' => self.push_bytes(b"\\\\"),
                0x08 => self.push_bytes(b"\\b"),
                0x09 => self.push_bytes(b"\\t"),
                0x0a => self.push_bytes(b"\\n"),
                0x0c => self.push_bytes(b"\\f"),
                0x0d => self.push_bytes(b"\\r"),
                0x00..=0x1f => {
                    let escaped = [
                        b'\\',
                        b'u',
                        b'0',
                        b'0',
                        lower_hex(byte >> 4),
                        lower_hex(byte & 0x0f),
                    ];
                    self.push_bytes(&escaped)
                }
                _ => self.push_byte(*byte),
            }?;
        }
        self.push_byte(b'"')
    }

    fn push_byte(&mut self, byte: u8) -> Result<(), CanonicalJsonError> {
        self.push_bytes(&[byte])
    }

    fn push_bytes(&mut self, bytes: &[u8]) -> Result<(), CanonicalJsonError> {
        let Some(next_len) = self.output.len().checked_add(bytes.len()) else {
            return Err(CanonicalJsonError::OutputTooLarge {
                max_bytes: MAX_CANONICAL_JSON_OUTPUT_BYTES,
            });
        };
        if next_len > MAX_CANONICAL_JSON_OUTPUT_BYTES {
            return Err(CanonicalJsonError::OutputTooLarge {
                max_bytes: MAX_CANONICAL_JSON_OUTPUT_BYTES,
            });
        }
        self.output.extend_from_slice(bytes);
        Ok(())
    }
}

const fn lower_hex(nibble: u8) -> u8 {
    match nibble {
        0..=9 => b'0' + nibble,
        _ => b'a' + (nibble - 10),
    }
}
