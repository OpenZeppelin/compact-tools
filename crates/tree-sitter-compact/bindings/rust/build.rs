fn main() {
    let src_dir = std::path::Path::new("src");

    let mut config = cc::Build::new();
    config.std("c11").include(src_dir);
    config.file(src_dir.join("parser.c"));

    // Generated code trips these on some compiler versions; they are not actionable here.
    config.flag_if_supported("-Wno-unused-but-set-variable");
    config.flag_if_supported("-Wno-unused-parameter");
    config.flag_if_supported("-Wno-trigraphs");

    config.compile("tree-sitter-compact");

    println!("cargo:rerun-if-changed=src/parser.c");
    println!("cargo:rerun-if-changed=src/grammar.json");
    println!("cargo:rerun-if-changed=src/node-types.json");
    println!("cargo:rerun-if-changed=src/tree_sitter");
}
