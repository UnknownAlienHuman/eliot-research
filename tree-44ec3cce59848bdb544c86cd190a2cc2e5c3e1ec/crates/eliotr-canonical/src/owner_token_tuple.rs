//! Strict JSON-tuple reader for the initial owner-token preimage.
//!
//! Accepts the canonical six-element tuple with tolerated surrounding whitespace, decodes JSON
//! strings including `\u` escapes, and enforces canonical safe-integer revision syntax. Field
//! semantics (schema, identifiers, owner, revision, status) are validated by the caller.

#![forbid(unsafe_code)]

use crate::owner_token::{OWNER_TOKEN_PARSER_STEPS_MAX, OwnerTokenError};

/// Decoded preimage tuple in fixed field order.
pub(crate) struct ParsedTuple {
    pub(crate) schema: String,
    pub(crate) namespace: String,
    pub(crate) owner: String,
    pub(crate) incarnation: String,
    pub(crate) revision: i64,
    pub(crate) status: String,
}

pub(crate) struct TupleParser<'a> {
    input: &'a [u8],
    cursor: usize,
}

impl<'a> TupleParser<'a> {
    pub(crate) const fn new(input: &'a [u8]) -> Self {
        Self { input, cursor: 0 }
    }

    pub(crate) fn parse(mut self) -> Result<ParsedTuple, OwnerTokenError> {
        self.skip_whitespace()?;
        if !self.consume_if(b'[') {
            return Err(self.syntax());
        }
        self.skip_whitespace()?;
        if self.peek() == Some(b']') {
            return Err(OwnerTokenError::Shape);
        }
        let schema = self.parse_string()?;
        self.skip_whitespace()?;
        self.consume_comma_or_end()?;
        self.skip_whitespace()?;
        let namespace = self.parse_string_or_shape()?;
        self.skip_whitespace()?;
        self.consume_comma_or_end()?;
        self.skip_whitespace()?;
        let owner = self.parse_string_or_shape()?;
        self.skip_whitespace()?;
        self.consume_comma_or_end()?;
        self.skip_whitespace()?;
        let incarnation = self.parse_string_or_shape()?;
        self.skip_whitespace()?;
        self.consume_comma_or_end()?;
        self.skip_whitespace()?;
        let revision = self.parse_revision()?;
        self.skip_whitespace()?;
        self.consume_comma_or_end()?;
        self.skip_whitespace()?;
        let status = self.parse_string_or_shape()?;
        self.skip_whitespace()?;
        if self.consume_if(b',') {
            return Err(OwnerTokenError::Shape);
        }
        if !self.consume_if(b']') {
            return Err(self.syntax());
        }
        self.skip_whitespace()?;
        if self.cursor != self.input.len() {
            return Err(self.syntax());
        }
        Ok(ParsedTuple {
            schema,
            namespace,
            owner,
            incarnation,
            revision,
            status,
        })
    }

    fn parse_string_or_shape(&mut self) -> Result<String, OwnerTokenError> {
        if self.peek() != Some(b'"') {
            return Err(OwnerTokenError::Shape);
        }
        self.parse_string()
    }

    fn parse_revision(&mut self) -> Result<i64, OwnerTokenError> {
        let start = self.cursor;
        match self.peek() {
            Some(b'-' | b'0'..=b'9') => {}
            _ => return Err(OwnerTokenError::Shape),
        }
        let negative = self.consume_if(b'-');
        let digits_start = self.cursor;
        match self.peek() {
            Some(b'0') => {
                self.cursor += 1;
                if matches!(self.peek(), Some(b'0'..=b'9')) {
                    return Err(self.syntax_at(start));
                }
            }
            Some(b'1'..=b'9') => {
                self.cursor += 1;
                // S5 bounded-iteration guard: a `+=`→`*=` mutant would stall `cursor`.
                let mut iterations = 0_usize;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    if iterations >= OWNER_TOKEN_PARSER_STEPS_MAX {
                        return Err(self.syntax_at(start));
                    }
                    iterations += 1;
                    self.cursor += 1;
                }
            }
            _ => return Err(self.syntax_at(start)),
        }
        if matches!(self.peek(), Some(b'.' | b'e' | b'E')) {
            return Err(self.syntax_at(start));
        }
        let mut magnitude = 0_i64;
        for byte in &self.input[digits_start..self.cursor] {
            let digit = i64::from(*byte - b'0');
            if magnitude > (i64::MAX - digit) / 10 {
                return Err(self.syntax_at(start));
            }
            magnitude = magnitude * 10 + digit;
        }
        if negative && magnitude == 0 {
            return Err(self.syntax_at(start));
        }
        Ok(if negative { -magnitude } else { magnitude })
    }

    fn parse_string(&mut self) -> Result<String, OwnerTokenError> {
        let start = self.cursor;
        if !self.consume_if(b'"') {
            return Err(self.syntax_at(start));
        }
        let mut output = Vec::new();
        // S5 bounded-iteration guard: every iteration must consume input.
        // Covers `+=`→`*=` stalls and `utf8_width`→`Some(0)` zero-progress.
        let mut iterations = 0_usize;
        loop {
            if iterations >= OWNER_TOKEN_PARSER_STEPS_MAX {
                return Err(self.syntax_at(start));
            }
            iterations += 1;
            let Some(byte) = self.peek() else {
                return Err(self.syntax_at(start));
            };
            match byte {
                b'"' => {
                    self.cursor += 1;
                    return String::from_utf8(output)
                        .map_err(|_error| OwnerTokenError::Unicode { offset: start });
                }
                b'\\' => {
                    self.cursor += 1;
                    self.parse_escape(&mut output, start)?;
                }
                0x00..=0x1f => return Err(self.syntax_at(start)),
                0x20..=0x7f => {
                    self.cursor += 1;
                    output.push(byte);
                }
                _ => {
                    let Some(width) = utf8_width(byte) else {
                        return Err(OwnerTokenError::Unicode {
                            offset: self.cursor,
                        });
                    };
                    let end = self.cursor.saturating_add(width);
                    let Some(bytes) = self.input.get(self.cursor..end) else {
                        return Err(OwnerTokenError::Unicode {
                            offset: self.cursor,
                        });
                    };
                    if !is_valid_continuation(bytes) {
                        return Err(OwnerTokenError::Unicode {
                            offset: self.cursor,
                        });
                    }
                    output.extend_from_slice(bytes);
                    self.cursor = end;
                }
            }
        }
    }

    fn parse_escape(&mut self, output: &mut Vec<u8>, start: usize) -> Result<(), OwnerTokenError> {
        let offset = self.cursor.saturating_sub(1);
        let Some(escape) = self.peek() else {
            return Err(self.syntax_at(start));
        };
        self.cursor += 1;
        match escape {
            b'"' => output.push(b'"'),
            b'\\' => output.push(b'\\'),
            b'/' => output.push(b'/'),
            b'b' => output.push(0x08),
            b'f' => output.push(0x0c),
            b'n' => output.push(b'\n'),
            b'r' => output.push(b'\r'),
            b't' => output.push(b'\t'),
            b'u' => self.parse_unicode_escape(output, offset)?,
            _ => return Err(self.syntax_at(start)),
        }
        Ok(())
    }

    fn parse_unicode_escape(
        &mut self,
        output: &mut Vec<u8>,
        offset: usize,
    ) -> Result<(), OwnerTokenError> {
        let first = self.parse_hex_quad(offset)?;
        let scalar = if (0xd800..=0xdbff).contains(&first) {
            if self.input.get(self.cursor..self.cursor.saturating_add(2)) != Some(b"\\u") {
                return Err(OwnerTokenError::Unicode { offset });
            }
            self.cursor += 2;
            let second = self.parse_hex_quad(offset)?;
            if !(0xdc00..=0xdfff).contains(&second) {
                return Err(OwnerTokenError::Unicode { offset });
            }
            0x1_0000 + ((u32::from(first) - 0xd800) << 10) + (u32::from(second) - 0xdc00)
        } else if (0xdc00..=0xdfff).contains(&first) {
            return Err(OwnerTokenError::Unicode { offset });
        } else {
            u32::from(first)
        };
        let Some(character) = char::from_u32(scalar) else {
            return Err(OwnerTokenError::Unicode { offset });
        };
        let mut encoded = [0_u8; 4];
        output.extend_from_slice(character.encode_utf8(&mut encoded).as_bytes());
        Ok(())
    }

    fn parse_hex_quad(&mut self, offset: usize) -> Result<u16, OwnerTokenError> {
        let end = self.cursor.saturating_add(4);
        let Some(bytes) = self.input.get(self.cursor..end) else {
            return Err(OwnerTokenError::Unicode { offset });
        };
        let mut value = 0_u16;
        for byte in bytes {
            let Some(nibble) = hex_nibble(*byte) else {
                return Err(OwnerTokenError::Unicode { offset });
            };
            value = (value << 4) | u16::from(nibble);
        }
        self.cursor = end;
        Ok(value)
    }

    fn consume_comma_or_end(&mut self) -> Result<(), OwnerTokenError> {
        if self.consume_if(b',') {
            Ok(())
        } else if self.peek() == Some(b']') {
            Err(OwnerTokenError::Shape)
        } else {
            Err(self.syntax())
        }
    }

    fn skip_whitespace(&mut self) -> Result<(), OwnerTokenError> {
        // S5 bounded-iteration guard: each iteration must advance `cursor`.
        // A `+=`→`*=` mutant would otherwise spin forever on `cursor == 0`.
        let mut iterations = 0_usize;
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            if iterations >= OWNER_TOKEN_PARSER_STEPS_MAX {
                return Err(self.syntax());
            }
            iterations += 1;
            self.cursor += 1;
        }
        Ok(())
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

    fn syntax(&self) -> OwnerTokenError {
        OwnerTokenError::Syntax {
            offset: self.cursor,
        }
    }

    fn syntax_at(&self, offset: usize) -> OwnerTokenError {
        OwnerTokenError::Syntax { offset }
    }
}

const fn utf8_width(byte: u8) -> Option<usize> {
    match byte {
        0xc2..=0xdf => Some(2),
        0xe0..=0xef => Some(3),
        0xf0..=0xf4 => Some(4),
        _ => None,
    }
}

fn is_valid_continuation(bytes: &[u8]) -> bool {
    core::str::from_utf8(bytes).is_ok()
}

const fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
