//! Parameter lists and type text.
//!
//! The grammar keeps a parameter list as an opaque run, so the split happens here: at
//! commas outside `<>`, `()`, `[]`, `{}` and string literals. Type text is lexed into
//! identifiers, strings, numbers and punctuation, and rewritten one identifier at a time.

/// One parameter as written: the pattern before the first top-level `:`, and its type.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawParam {
    /// The pattern, trimmed. A single identifier is the parameter's name.
    pub pattern: String,
    /// The type, whitespace-collapsed.
    pub ty: String,
}

impl RawParam {
    /// The name, or `None` when the pattern destructures.
    #[must_use]
    pub fn name(&self) -> Option<&str> {
        is_identifier(&self.pattern).then_some(self.pattern.as_str())
    }
}

/// Splits a parameter list, parentheses included, with comments already blanked.
///
/// A trailing comma is dropped. An empty part anywhere else, a part without a top-level
/// `:`, or an unbalanced bracket is an error.
/// # Errors
/// Returns the byte offset into `list` where the defect starts.
pub fn split(list: &str) -> Result<Vec<RawParam>, usize> {
    let inner_start = usize::from(list.starts_with('('));
    let inner_end = if list.len() > inner_start && list.ends_with(')') {
        list.len() - 1
    } else {
        list.len()
    };
    let inner = &list[inner_start..inner_end];

    let parts = split_top_level(inner, ',').map_err(|offset| inner_start + offset)?;
    let trailing = parts.len() - 1;
    let mut params = Vec::new();
    for (index, (offset, part)) in parts.iter().enumerate() {
        let absolute = inner_start + offset;
        if part.trim().is_empty() {
            // `()` has one empty part; `(a,)` ends with one.
            if index == trailing && (index > 0 || parts.len() == 1) {
                continue;
            }
            return Err(absolute);
        }
        let pieces = split_top_level(part, ':').map_err(|at| absolute + at)?;
        let Some((_, pattern)) = pieces.first() else {
            return Err(absolute);
        };
        let Some(&(colon, _)) = pieces.get(1) else {
            return Err(absolute + leading_space(part));
        };
        // Everything after the first top-level `:`, colons inside the type included.
        let ty = collapse(&part[colon..]);
        if ty.is_empty() || pattern.trim().is_empty() {
            return Err(absolute + leading_space(part));
        }
        params.push(RawParam {
            pattern: pattern.trim().to_owned(),
            ty,
        });
    }
    Ok(params)
}

/// The field types of a struct body, braces included, with comments already blanked.
///
/// Fields end in `;` or `,` outside brackets. A field with no top-level `:`, or a body
/// that does not split, yields its whole text, so caller matching still sees every name.
#[must_use]
pub fn field_types(body: &str) -> Vec<String> {
    let inner = body
        .strip_prefix('{')
        .and_then(|rest| rest.strip_suffix('}'))
        .unwrap_or(body);
    let Ok(parts) = split_top_level(inner, ';') else {
        return vec![collapse(inner)];
    };
    let mut types = Vec::new();
    for (_, part) in parts {
        let Ok(fields) = split_top_level(part, ',') else {
            types.push(collapse(part));
            continue;
        };
        for (_, field) in fields {
            if field.trim().is_empty() {
                continue;
            }
            let ty = match split_top_level(field, ':').ok().as_deref() {
                Some([_, (colon, _), ..]) => collapse(&field[*colon..]),
                _ => collapse(field),
            };
            types.push(ty);
        }
    }
    types
}

fn leading_space(text: &str) -> usize {
    text.len() - text.trim_start().len()
}

/// Splits `text` at every `separator` outside brackets and strings, returning each part
/// with its byte offset.
fn split_top_level(text: &str, separator: char) -> Result<Vec<(usize, &str)>, usize> {
    let mut parts = Vec::new();
    let mut depth = 0usize;
    let mut start = 0;
    let mut chars = text.char_indices().peekable();
    while let Some((at, ch)) = chars.next() {
        match ch {
            '"' | '\'' => skip_string(&mut chars, ch),
            '<' | '(' | '[' | '{' => depth += 1,
            '>' | ')' | ']' | '}' => depth = depth.checked_sub(1).ok_or(at)?,
            _ if ch == separator && depth == 0 => {
                parts.push((start, &text[start..at]));
                start = at + ch.len_utf8();
            }
            _ => {}
        }
    }
    if depth != 0 {
        return Err(start);
    }
    parts.push((start, &text[start..]));
    Ok(parts)
}

fn skip_string(chars: &mut std::iter::Peekable<std::str::CharIndices<'_>>, quote: char) {
    while let Some((_, ch)) = chars.next() {
        match ch {
            '\\' => {
                chars.next();
            }
            _ if ch == quote => return,
            _ => {}
        }
    }
}

/// One lexical piece of type text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Token<'a> {
    Identifier(&'a str),
    Str(&'a str),
    Number(&'a str),
    Punct(&'a str),
    Space,
}

/// Lexes type text. A whitespace run becomes one [`Token::Space`].
#[must_use]
pub fn tokens(text: &str) -> Vec<Token<'_>> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let rest = &text[at..];
        let ch = rest.chars().next().unwrap_or_default();
        let len = if ch.is_whitespace() {
            let len = rest.len() - rest.trim_start().len();
            out.push(Token::Space);
            len
        } else if ch == '"' || ch == '\'' {
            let len = string_len(rest, ch);
            out.push(Token::Str(&rest[..len]));
            len
        } else if is_identifier_start(ch) {
            let len = rest
                .find(|next: char| !is_identifier_continue(next))
                .unwrap_or(rest.len());
            out.push(Token::Identifier(&rest[..len]));
            len
        } else if ch.is_ascii_digit() {
            let len = rest
                .find(|next: char| !next.is_ascii_digit())
                .unwrap_or(rest.len());
            out.push(Token::Number(&rest[..len]));
            len
        } else {
            let len = ch.len_utf8();
            out.push(Token::Punct(&rest[..len]));
            len
        };
        at += len;
    }
    out
}

fn string_len(text: &str, quote: char) -> usize {
    let mut chars = text.char_indices().skip(1);
    while let Some((at, ch)) = chars.next() {
        if ch == '\\' {
            chars.next();
        } else if ch == quote {
            return at + ch.len_utf8();
        }
    }
    text.len()
}

/// Every identifier token in `text`, in order.
pub fn identifiers(text: &str) -> impl Iterator<Item = &str> {
    tokens(text).into_iter().filter_map(|token| match token {
        Token::Identifier(name) => Some(name),
        _ => None,
    })
}

/// Collapses whitespace runs outside string literals to one space and trims the ends.
#[must_use]
pub fn collapse(text: &str) -> String {
    rewrite(text, |_| None)
}

/// Rewrites identifier tokens through `replace`, keeping every other token, and collapses
/// whitespace as [`collapse`] does. `None` keeps the identifier.
pub fn rewrite(text: &str, mut replace: impl FnMut(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_space = false;
    for token in tokens(text) {
        let piece = match token {
            Token::Space => {
                pending_space = true;
                continue;
            }
            Token::Identifier(name) => replace(name).unwrap_or_else(|| name.to_owned()),
            Token::Str(text) | Token::Number(text) | Token::Punct(text) => text.to_owned(),
        };
        if pending_space && !out.is_empty() {
            out.push(' ');
        }
        pending_space = false;
        out.push_str(&piece);
    }
    out
}

/// Whether `text` is one identifier, `[A-Za-z_$][A-Za-z0-9_$]*`.
#[must_use]
pub fn is_identifier(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(is_identifier_start) && chars.all(is_identifier_continue)
}

/// Whether `text` is a config name: `[A-Za-z_][A-Za-z0-9_]*`.
#[must_use]
pub fn is_name(text: &str) -> bool {
    let mut chars = text.chars();
    chars
        .next()
        .is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '_')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

const fn is_identifier_start(ch: char) -> bool {
    ch.is_ascii_alphabetic() || ch == '_' || ch == '$'
}

const fn is_identifier_continue(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_' || ch == '$'
}

#[cfg(test)]
mod tests {
    use super::{collapse, field_types, identifiers, is_name, rewrite, split};

    fn shapes(list: &str) -> Vec<(Option<String>, String)> {
        split(list)
            .expect("the list splits")
            .into_iter()
            .map(|param| (param.name().map(str::to_owned), param.ty))
            .collect()
    }

    fn named(name: &str, ty: &str) -> (Option<String>, String) {
        (Some(name.to_owned()), ty.to_owned())
    }

    #[test]
    fn empty_lists_have_no_parameters() {
        assert!(shapes("()").is_empty());
        assert!(shapes("( )").is_empty());
    }

    #[test]
    fn a_trailing_comma_is_dropped() {
        assert_eq!(shapes("(a: A,)"), vec![named("a", "A")]);
        assert_eq!(
            shapes("(id: Bytes<32>, counter: Uint<64>,)"),
            vec![named("id", "Bytes<32>"), named("counter", "Uint<64>")]
        );
    }

    #[test]
    fn commas_inside_brackets_do_not_split() {
        assert_eq!(
            shapes("(id: Either<Bytes<32>, ContractAddress>)"),
            vec![named("id", "Either<Bytes<32>, ContractAddress>")]
        );
        assert_eq!(
            shapes("(v: Vector<2, Maybe<Field>>)"),
            vec![named("v", "Vector<2, Maybe<Field>>")]
        );
    }

    #[test]
    fn strings_are_skipped_with_their_escapes() {
        assert_eq!(
            shapes(r#"(o: Opaque<"a,b">)"#),
            vec![named("o", r#"Opaque<"a,b">"#)]
        );
        assert_eq!(
            shapes(r#"(o: Opaque<"a\"b">)"#),
            vec![named("o", r#"Opaque<"a\"b">"#)]
        );
    }

    #[test]
    fn a_blanked_comment_leaves_one_parameter() {
        assert_eq!(shapes("(a: A,            )"), vec![named("a", "A")]);
    }

    #[test]
    fn a_destructuring_pattern_has_no_name() {
        let params = split("({a, b}: S, [x, y]: Vector<2, F>)").expect("the list splits");
        assert_eq!(params.len(), 2);
        assert_eq!(params[0].name(), None);
        assert_eq!(params[1].name(), None);
        assert_eq!(params[1].ty, "Vector<2, F>");
    }

    #[test]
    fn names_and_types_are_trimmed() {
        assert_eq!(shapes("(a : A)"), vec![named("a", "A")]);
        assert_eq!(
            shapes("(\n  caller: Caller,\n  newOwner: Identifier\n  )"),
            vec![named("caller", "Caller"), named("newOwner", "Identifier")]
        );
    }

    #[test]
    fn malformed_lists_report_the_part_offset() {
        assert_eq!(split("(,)"), Err(1));
        assert_eq!(split("( , )"), Err(1));
        assert_eq!(split("(a: A,, b: B)"), Err(6));
        assert_eq!(split("(a A)"), Err(1));
        assert_eq!(split("(a:)"), Err(1));
        assert_eq!(split("(: A)"), Err(1));
        assert!(split("(a: Vector<2, F)").is_err());
        assert!(split("(a: A>)").is_err());
    }

    #[test]
    fn colons_and_commas_inside_strings_do_not_split() {
        assert_eq!(
            shapes(r#"(o: Opaque<"a:b">, p: Opaque<'c,d'>)"#),
            vec![named("o", r#"Opaque<"a:b">"#), named("p", "Opaque<'c,d'>")]
        );
    }

    #[test]
    fn a_multi_line_type_collapses_to_single_spaces() {
        assert_eq!(
            collapse("Either<\n    Bytes<32>,\n    ContractAddress\n  >"),
            "Either< Bytes<32>, ContractAddress >"
        );
    }

    #[test]
    fn rewrite_keeps_numbers_and_punctuation() {
        assert_eq!(
            rewrite("Vector<32, Maybe<T>>", |name| (name == "T")
                .then(|| "Uint<0..8>".to_owned())),
            "Vector<32, Maybe<Uint<0..8>>>"
        );
    }

    #[test]
    fn collapse_keeps_string_spacing() {
        assert_eq!(
            collapse("  Vector<n,\n   Bytes<32>>  "),
            "Vector<n, Bytes<32>>"
        );
        assert_eq!(collapse(r#"Opaque<"a  b">"#), r#"Opaque<"a  b">"#);
    }

    #[test]
    fn rewrite_touches_identifiers_only() {
        let rewritten = rewrite(r#"Pair<T, Opaque<"T">, 32, Local>"#, |name| match name {
            "T" => Some("Field".to_owned()),
            "Local" => Some("M_Local".to_owned()),
            _ => None,
        });
        assert_eq!(rewritten, r#"Pair<Field, Opaque<"T">, 32, M_Local>"#);
    }

    #[test]
    fn struct_fields_split_at_semicolons_and_commas_outside_brackets() {
        assert_eq!(
            field_types("{ a: Field; b: Either<Bytes<32>, C>, c: Maybe<D> }"),
            ["Field", "Either<Bytes<32>, C>", "Maybe<D>"]
        );
        assert!(field_types("{ }").is_empty());
        assert_eq!(field_types("{ odd Caller; }"), ["odd Caller"]);
        assert_eq!(field_types("{ a: Vector<2, F; }"), ["a: Vector<2, F;"]);
    }

    #[test]
    fn a_dollar_sign_is_part_of_an_identifier() {
        assert_eq!(identifiers("A$b<C>").collect::<Vec<_>>(), vec!["A$b", "C"]);
    }

    #[test]
    fn config_names_exclude_the_dollar_sign() {
        assert!(is_name("MockGate"));
        assert!(is_name("_x1"));
        assert!(!is_name("1x"));
        assert!(!is_name("a$"));
        assert!(!is_name(""));
    }
}
