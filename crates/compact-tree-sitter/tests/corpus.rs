//! Real Compact sources must parse with no `ERROR` and no `MISSING` node.

use std::path::{Path, PathBuf};

use tree_sitter::{Node, Parser, Tree};

/// Directories that never hold first-party Compact sources.
const SKIPPED_DIRS: [&str; 5] = ["node_modules", "target", "dist", "build", ".git"];

fn parser() -> Parser {
    let mut parser = Parser::new();
    parser
        .set_language(&compact_tree_sitter::LANGUAGE.into())
        .expect("the generated parser matches the tree-sitter ABI this crate builds against");
    parser
}

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("the crate sits two levels below the workspace root")
}

fn compact_files(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for dir in dirs {
        collect_compact_files(dir, &mut files);
    }
    files.sort();
    files
}

fn collect_compact_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = std::fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("corpus directory {} is readable: {error}", dir.display()));

    for entry in entries {
        let entry = entry.expect("a directory entry read without error");
        let path = entry.path();
        let name = entry.file_name();

        if path.is_dir() {
            if !SKIPPED_DIRS.iter().any(|skipped| name == *skipped) {
                collect_compact_files(&path, out);
            }
        } else if path
            .extension()
            .is_some_and(|extension| extension == "compact")
        {
            out.push(path);
        }
    }
}

fn child_kinds(node: Node) -> Vec<&'static str> {
    let mut cursor = node.walk();
    let mut kinds = Vec::new();
    for child in node.children(&mut cursor) {
        kinds.push(child.kind());
    }
    kinds
}

struct Defect {
    kind: String,
    start: usize,
    end: usize,
    excerpt: String,
}

fn excerpt(source: &str, start: usize) -> String {
    let tail = &source[start..];
    let mut end = 0;
    for (index, character) in tail.char_indices().take(120) {
        end = index + character.len_utf8();
    }
    tail[..end].replace('\n', "\\n")
}

fn find_defect(node: Node, source: &str) -> Option<Defect> {
    if node.is_error() || node.is_missing() {
        let start = node.start_byte();
        return Some(Defect {
            kind: if node.is_missing() {
                format!("MISSING {}", node.kind())
            } else {
                node.kind().to_owned()
            },
            start,
            end: node.end_byte(),
            excerpt: excerpt(source, start),
        });
    }

    if !node.has_error() {
        return None;
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if let Some(defect) = find_defect(child, source) {
            return Some(defect);
        }
    }
    None
}

fn assert_parses_clean(parser: &mut Parser, files: &[PathBuf]) {
    for path in files {
        let source = std::fs::read_to_string(path)
            .unwrap_or_else(|error| panic!("{} is readable UTF-8: {error}", path.display()));
        let tree: Tree = parser
            .parse(&source, None)
            .unwrap_or_else(|| panic!("{} produced a parse tree", path.display()));

        if let Some(defect) = find_defect(tree.root_node(), &source) {
            let Defect {
                kind,
                start,
                end,
                excerpt,
            } = defect;
            panic!(
                "{}: {kind} at bytes {start}..{end}\n  {excerpt}",
                path.display()
            );
        }
    }
}

#[test]
fn upstream_corpus_parses_without_defects() {
    let files =
        compact_files(&[Path::new(env!("CARGO_MANIFEST_DIR")).join("test/fixtures/upstream")]);

    assert!(
        !files.is_empty(),
        "the upstream fixture directory is populated"
    );
    println!("upstream corpus: {} files", files.len());
    assert_parses_clean(&mut parser(), &files);
}

#[test]
fn in_repo_corpus_parses_without_defects() {
    let root = workspace_root();
    let files = compact_files(&[
        root.join("tests/integrations/fixtures"),
        root.join("examples"),
        root.join("packages/simulator/test/fixtures/sample-contracts"),
    ]);

    assert!(!files.is_empty(), "the repository ships Compact sources");
    println!("in-repo corpus: {} files", files.len());
    assert_parses_clean(&mut parser(), &files);
}

#[test]
fn external_corpus_parses_without_defects() {
    let Ok(dir) = std::env::var("COMPACT_CORPUS_DIR") else {
        println!("external corpus: COMPACT_CORPUS_DIR unset, nothing checked");
        return;
    };

    let files = compact_files(&[PathBuf::from(&dir)]);

    assert!(
        !files.is_empty(),
        "COMPACT_CORPUS_DIR holds Compact sources"
    );
    println!("external corpus: {} files under {dir}", files.len());
    assert_parses_clean(&mut parser(), &files);
}

#[test]
fn doc_commented_export_pure_circuit_exposes_name_and_modifiers() {
    let source = "/** @description Adds two numbers. */\n\
                  export pure circuit add(a: Uint<32>, b: Uint<32>): Uint<64> {\n\
                  \x20 return a + b;\n\
                  }\n";

    let tree = parser()
        .parse(source, None)
        .expect("the snippet produced a parse tree");
    let root = tree.root_node();
    assert!(!root.has_error(), "the snippet parsed without defects");
    assert_eq!(child_kinds(root), ["doc_comment", "circuit_declaration"]);

    let circuit = root.child(1).expect("the circuit follows its doc comment");
    assert_eq!(
        child_kinds(circuit),
        [
            "export",
            "pure",
            "circuit",
            "identifier",
            "parameter_list",
            ":",
            "type_expression",
            "block",
        ]
    );

    let name = circuit
        .child_by_field_name("name")
        .expect("a circuit declaration carries a name field");
    assert_eq!(
        name.utf8_text(source.as_bytes())
            .expect("the source is valid UTF-8"),
        "add"
    );
}
