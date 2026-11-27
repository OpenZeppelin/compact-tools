use std::collections::BTreeMap;
use std::path::Path;

use super::{Analysis, ImportLine, MockPlan, Scope, Status, analyze};
use crate::config::{CONFIG_FILE_NAME, Paths, load};
use crate::render::render;
use crate::scope::Files;

/// A small source tree every case shares. Bodies only need to parse.
const SOURCES: &[(&str, &str)] = &[
    (
        "who/Who.compact",
        "pragma language_version >= 0.28.0;\nmodule Who {\n  export struct Caller { id: Bytes<32> }\n  export new type Tag = Bytes<32>;\n}\n",
    ),
    (
        "rand/Rand.compact",
        "pragma language_version >= 0.28.0;\nmodule Rand {\n  export new type Blinding = Bytes<32>;\n  witness wit_blinding(): Bytes<32>;\n  export circuit read(): Blinding { return Blinding { wit_blinding() }; }\n  export circuit raw(): Bytes<32> { return wit_blinding(); }\n}\n",
    ),
    (
        "auth/Prf.compact",
        "pragma language_version >= 0.28.0;\nmodule Prf {\n  import { Caller } from \"../who/Who\";\n  witness secret(): Bytes<32>;\n  export circuit authenticate(salt: Bytes<32>): Caller { return Caller { secret() }; }\n  export circuit plain(): Field { return 1; }\n}\n",
    ),
    (
        "auth/Ecdsa.compact",
        "pragma language_version >= 0.28.0;\nmodule Ecdsa {\n  import { Caller } from \"../who/Who\";\n  export circuit authenticateForThisContract(): Caller { return Caller { pad(32, \"\") }; }\n}\n",
    ),
    (
        "door/Door.compact",
        "pragma language_version >= 0.28.0;\nmodule Door {\n  import { Caller } from \"../who/Who\";\n  import { Blinding } from \"../rand/Rand\";\n  export ledger _salt: Bytes<32>;\n  export ledger opened: Counter;\n  export circuit initialize(caller: Caller, salt: Bytes<32>): [] { }\n  export circuit open(caller: Caller, blinding: Blinding, n: Field): [] { }\n  export circuit commit(blinding: Blinding): Bytes<32> { return blinding; }\n  export pure circuit peek(x: Field): Field { return x; }\n}\n",
    ),
    (
        "math/Gen.compact",
        "pragma language_version >= 0.28.0;\nmodule Gen<#N> {\n  export ledger total: Field;\n  export circuit initialize(seed: Field, owner: Bytes<32>): [] { }\n  export pure circuit add(a: Uint<N>, b: Uint<N>): Uint<N> { return a; }\n  export circuit bump(): [] { }\n}\n",
    ),
    (
        "over/Dial.compact",
        "pragma language_version >= 0.28.0;\nmodule Dial {\n  export circuit turn(x: Field): Field { return x; }\n  export circuit turn(x: Field, y: Uint<8>): Field { return x; }\n  export circuit stop(): Field { return 0; }\n}\n",
    ),
    (
        "iface/Iface.compact",
        "pragma language_version >= 0.28.0;\nmodule Iface {\n  export contract Tally {\n    circuit get(): Field;\n    circuit bump(n: Field): [];\n  }\n  export circuit get(): Field { return 0; }\n  export circuit poke(t: Tally): [] { }\n}\n",
    ),
    (
        "list/Impl.compact",
        "pragma language_version >= 0.28.0;\nmodule Impl {\n  import { Tag } from \"../who/Who\";\n  export circuit inner(t: Tag): Field { return 0; }\n}\n",
    ),
    (
        "list/Facade.compact",
        "pragma language_version >= 0.28.0;\nmodule Facade {\n  import { inner } from \"./Impl\";\n  export { inner };\n  export circuit own(): Field { return 0; }\n}\n",
    ),
    (
        "clash/Clash.compact",
        "pragma language_version >= 0.28.0;\nmodule Clash {\n  import \"../auth/Prf\" prefix P_;\n  witness secret(): Field;\n  export circuit ping(): Field { return 0; }\n}\n",
    ),
    (
        "presets/Preset.compact",
        "pragma language_version >= 0.28.0;\nimport CompactStandardLibrary;\nexport circuit go(): [] { }\n",
    ),
    (
        "empty/Empty.compact",
        "pragma language_version >= 0.28.0;\nmodule Empty {\n  export ledger x: Field;\n}\n",
    ),
];

const CALLER: &str = "caller_type = { name = \"Caller\", module = \"who/Who\" }\n";

const PRF: &str =
    "[mock.auth.prf]\nmodule = \"auth/Prf\"\ncall = 'authenticate(pad(32, \"{salt}\"))'\n";

const BLINDING: &str = "[mock.inject.blinding]\nmodule = \"rand/Rand\"\ntype = { name = \"Blinding\", module = \"rand/Rand\" }\ncall = \"read()\"\n";

struct Run {
    _directory: tempfile::TempDir,
    analysis: Analysis,
}

impl Run {
    fn errors(&self) -> Vec<String> {
        self.analysis
            .fatal()
            .iter()
            .map(ToString::to_string)
            .collect()
    }

    fn plans(&self) -> BTreeMap<String, MockPlan> {
        assert!(self.errors().is_empty(), "{:?}", self.errors());
        self.analysis
            .plans()
            .into_iter()
            .map(|plan| (plan.name.clone(), plan.clone()))
            .collect()
    }

    fn names(&self) -> Vec<String> {
        self.analysis
            .plans()
            .into_iter()
            .map(|plan| plan.name.clone())
            .collect()
    }

    fn text(&self, name: &str) -> String {
        render(&self.plans()[name])
    }
}

fn run_with(table: &str, extra: &[(&str, &str)], dir: Option<&str>, names: &[&str]) -> Run {
    let directory = tempfile::TempDir::new().expect("a temporary directory");
    for (path, text) in SOURCES.iter().chain(extra) {
        let target = directory.path().join("src").join(path);
        std::fs::create_dir_all(target.parent().expect("a parent")).expect("dirs");
        std::fs::write(target, text).expect("written");
    }
    let config = directory.path().join(CONFIG_FILE_NAME);
    std::fs::write(&config, format!("[mock]\n{table}")).expect("written");
    let paths = Paths {
        cwd: directory.path().to_owned(),
    };
    let loaded = load(&config, &paths).unwrap_or_else(|errors| panic!("{errors:?}"));
    let dir = dir.map(|dir| directory.path().join(dir));
    let names: Vec<String> = names.iter().map(|name| (*name).to_owned()).collect();
    let analysis = analyze(
        &loaded,
        &mut Files::new(paths),
        Scope {
            dir: dir.as_deref(),
            names: &names,
            only: &[],
        },
    );
    Run {
        _directory: directory,
        analysis,
    }
}

fn run(table: &str) -> Run {
    run_with(table, &[], None, &[])
}

fn rule(modules: &str, rest: &str) -> String {
    format!("[[mock.rules]]\nmodules = [{modules}]\n{rest}")
}

fn wrapper_names(plan: &MockPlan) -> Vec<&str> {
    plan.wrappers
        .iter()
        .map(|wrapper| wrapper.name.as_str())
        .collect()
}

#[test]
fn mocks_follow_module_path_then_group_then_auth_order() {
    let result = run(&format!(
        "{CALLER}{PRF}{}{}",
        rule("\"door/*\", \"math/*\"", "auth = [\"caller\", \"prf\"]\n"),
        rule(
            "\"math/Gen\"",
            "instances = [{ suffix = \"B\", module_args = [\"2\"] }, { suffix = \"A\", module_args = [\"1\"] }]\n"
        ),
    ));
    assert_eq!(
        result.names(),
        ["MockDoorCaller", "MockDoor", "MockGenB", "MockGenA"]
    );
}

#[test]
fn a_module_without_a_caller_parameter_gets_one_mock_and_no_authenticator() {
    let result = run(&format!(
        "{CALLER}{PRF}{}",
        rule("\"over/*\"", "auth = [\"prf\", \"caller\"]\n")
    ));
    assert_eq!(result.names(), ["MockDial"]);
    assert!(!result.text("MockDial").contains("Prf"));
}

#[test]
fn without_an_auth_key_no_authenticator_is_injected() {
    let result = run(&format!("{CALLER}{PRF}{}", rule("\"door/Door\"", "")));
    assert_eq!(result.names(), ["MockDoorCaller"]);
    let text = result.text("MockDoorCaller");
    assert!(!text.contains("Prf_authenticate") && !text.contains("auth/Prf"));
}

#[test]
fn names_expand_every_placeholder_and_reject_a_non_identifier() {
    let result = run(&rule(
        "\"math/Gen\"",
        "name = \"{dir}X{module}{instance}{suffix}\"\ninstances = [{ suffix = \"7\", module_args = [\"7\"] }]\n",
    ));
    assert_eq!(result.names(), ["MathXGen7"]);
    let bad = run(&rule("\"over/Dial\"", "name = \"{instance}\"\n"));
    assert_eq!(
        bad.errors(),
        [
            "config compact.toml: name template \"{instance}\" gives \"\" for over/Dial, which is not an identifier"
        ]
    );
}

#[test]
fn names_equal_under_case_folding_are_one_error_with_the_dir_hint() {
    let result = run_with(
        &rule("\"**\"", "name = \"M{module}\"\n"),
        &[(
            "other/dial.compact",
            "pragma language_version >= 0.28.0;\nmodule dial {\n  export circuit t(): Field { return 0; }\n}\n",
        )],
        None,
        &[],
    );
    assert!(
        result.errors().iter().any(|error| error.starts_with(
            "config compact.toml: two mocks are named MDial (ignoring case), from other/dial and over/Dial"
        ) && error.ends_with("add {dir} or {instance} to the name template")),
        "{:?}",
        result.errors()
    );
}

#[test]
fn overloads_get_numbered_names_unless_a_signature_rename_picks_one() {
    let result = run(&rule("\"over/Dial\"", ""));
    let plans = result.plans();
    assert_eq!(wrapper_names(&plans["MockDial"]), ["turn", "turn2"]);
    let renamed = run(&rule(
        "\"over/Dial\"",
        "rename = { \"turn(Field, Uint<8>)\" = \"turnTwo\" }\n",
    ));
    let renamed = renamed.plans();
    assert_eq!(wrapper_names(&renamed["MockDial"]), ["turn", "turnTwo"]);
    let calls: Vec<&str> = renamed["MockDial"]
        .wrappers
        .iter()
        .map(|wrapper| wrapper.call.callee.as_str())
        .collect();
    assert_eq!(calls, ["Dial_turn", "Dial_turn"]);
}

#[test]
fn an_overload_name_that_clashes_and_a_key_matching_no_overload_are_errors() {
    let knob = (
        "over/Knob.compact",
        "pragma language_version >= 0.28.0;\nmodule Knob {\n  export circuit turn(x: Field): Field { return x; }\n  export circuit turn(x: Field, y: Field): Field { return x; }\n  export circuit turn2(): Field { return 0; }\n}\n",
    );
    let clash = run_with(&rule("\"over/Knob\"", ""), &[knob], None, &[]);
    assert_eq!(
        clash.errors(),
        ["MockKnob: rename target turn2 clashes with circuit turn2"]
    );
    let missing = run(&rule(
        "\"over/Dial\"",
        "rename = { \"turn(Boolean)\" = \"t\" }\n",
    ));
    assert_eq!(
        missing.errors(),
        ["MockDial: rename key \"turn(Boolean)\" matches no overload of turn"]
    );
}

#[test]
fn an_injector_with_caller_scope_fills_only_beside_an_injected_caller() {
    let result = run(&format!(
        "{CALLER}{PRF}{BLINDING}{}",
        rule(
            "\"door/Door\"",
            "auth = [\"prf\", \"caller\"]\ninject = [\"blinding\"]\n"
        )
    ));
    let plans = result.plans();
    let open = plans["MockDoor"]
        .wrappers
        .iter()
        .find(|wrapper| wrapper.name == "open")
        .expect("open");
    assert_eq!(
        open.call.args,
        [
            "Prf_authenticate(pad(32, \"MockDoor\"))",
            "Rand_read()",
            "n"
        ]
    );
    let commit = plans["MockDoor"]
        .wrappers
        .iter()
        .find(|wrapper| wrapper.name == "commit");
    assert!(commit.is_none(), "commit is re-exported with its blinding");
    assert!(result.text("MockDoor").contains("commit"));
    let caller = result.text("MockDoorCaller");
    assert!(!caller.contains("Rand_read()") && !caller.contains("rand/Rand\" prefix"));
}

#[test]
fn an_injector_with_all_scope_fills_every_matching_parameter() {
    let table = format!(
        "{CALLER}{PRF}{}{}",
        BLINDING.replace(
            "call = \"read()\"\n",
            "call = \"read()\"\nscope = \"all\"\n"
        ),
        rule(
            "\"door/Door\"",
            "auth = [\"caller\"]\ninject = [\"blinding\"]\n"
        )
    );
    let result = run(&table);
    let commit = result.plans()["MockDoorCaller"]
        .wrappers
        .iter()
        .find(|wrapper| wrapper.name == "commit")
        .expect("commit is wrapped")
        .clone();
    assert!(commit.params.is_empty());
    assert_eq!(commit.call.args, ["Rand_read()"]);
}

#[test]
fn a_new_type_matches_only_itself_never_its_underlying_type() {
    let table = format!(
        "{}{}",
        BLINDING.replace(
            "call = \"read()\"\n",
            "call = \"read()\"\nscope = \"all\"\n"
        ),
        rule("\"rand/Rand\"", "inject = [\"blinding\"]\n")
    );
    let result = run(&table);
    let plan = &result.plans()["MockRand"];
    assert!(plan.wrappers.is_empty());
    assert!(render(plan).contains("import { read, raw } from"));
}

#[test]
fn a_ledger_or_expression_salt_replaces_the_whole_slot() {
    let ledger = run(&format!(
        "{CALLER}{PRF}{}",
        rule(
            "\"door/Door\"",
            "auth = [\"prf\"]\ninit = \"none\"\nsalt = { ledger = \"_salt\" }\n"
        )
    ));
    assert!(
        ledger
            .text("MockDoor")
            .contains("Prf_authenticate(Door__salt)")
    );
    let expr = run(&format!(
        "{CALLER}{PRF}{}",
        rule(
            "\"door/Door\"",
            "auth = [\"prf\"]\ninit = \"none\"\nsalt = { expr = \"pad(32, \\\"x\\\")\" }\n"
        )
    ));
    assert!(
        expr.text("MockDoor")
            .contains("Prf_authenticate(pad(32, \"x\"))")
    );
    let missing = run(&format!(
        "{CALLER}{PRF}{}",
        rule(
            "\"door/Door\"",
            "auth = [\"prf\"]\nsalt = { ledger = \"_nope\" }\n"
        )
    ));
    assert_eq!(
        missing.errors(),
        ["MockDoor: salt ledger field _nope is not an exported ledger field of door/Door"]
    );
}

#[test]
fn a_text_salt_is_checked_against_the_width_the_call_gives() {
    let narrow = PRF.replace("pad(32,", "pad(8,");
    let result = run(&format!(
        "{CALLER}{narrow}{}",
        rule("\"door/Door\"", "auth = [\"prf\"]\n")
    ));
    assert!(
        result.errors().is_empty(),
        "an 8-byte name fits pad(8, ...)"
    );
    let over = run(&format!(
        "{CALLER}{narrow}{}",
        rule("\"door/Door\"", "auth = [\"prf\"]\nsalt = \"123456789\"\n")
    ));
    assert_eq!(
        over.errors(),
        ["MockDoor: salt \"123456789\" is 9 bytes; pad(8, ...) takes at most 8. Set salt"]
    );
    let bare = PRF.replace("pad(32, \"{salt}\")", "\"{salt}\"");
    let long = run(&format!(
        "{CALLER}{bare}{}",
        rule(
            "\"door/Door\"",
            "auth = [\"prf\"]\nsalt = \"a salt far longer than thirty-two bytes\"\n"
        )
    ));
    assert!(long.errors().is_empty(), "{:?}", long.errors());
}

#[test]
fn a_call_without_a_salt_slot_ignores_a_rule_salt() {
    let ecdsa = "[mock.auth.ecdsa]\nmodule = \"auth/Ecdsa\"\ncall = \"authenticateForThisContract()\"\nsuffix = \"Ecdsa\"\n";
    let result = run(&format!(
        "{CALLER}{PRF}{ecdsa}{}",
        rule(
            "\"door/Door\"",
            "auth = [\"prf\", \"ecdsa\", \"caller\"]\nsalt = \"door\"\n"
        )
    ));
    assert_eq!(
        result.names(),
        ["MockDoor", "MockDoorEcdsa", "MockDoorCaller"]
    );
    assert!(
        result
            .text("MockDoor")
            .contains("Prf_authenticate(pad(32, \"door\"))")
    );
    assert!(
        result
            .text("MockDoorEcdsa")
            .contains("Ecdsa_authenticateForThisContract()")
    );
}

#[test]
fn authenticator_and_injector_calls_must_return_the_type_they_stand_in_for() {
    let wrong = "[mock.auth.prf]\nmodule = \"auth/Prf\"\ncall = \"plain()\"\n";
    let result = run(&format!("{CALLER}{wrong}{}", rule("\"door/Door\"", "")));
    assert_eq!(
        result.errors(),
        ["[mock.auth.prf].call: plain returns Field, not Caller"]
    );
    let raw = BLINDING.replace("call = \"read()\"", "call = \"raw()\"");
    let result = run(&format!("{raw}{}", rule("\"door/Door\"", "")));
    assert_eq!(
        result.errors(),
        ["[mock.inject.blinding].call: raw returns Bytes<32>, not Blinding"]
    );
    let missing = "[mock.auth.prf]\nmodule = \"auth/Prf\"\ncall = \"nope()\"\n";
    let result = run(&format!("{CALLER}{missing}{}", rule("\"door/Door\"", "")));
    assert_eq!(
        result.errors(),
        ["[mock.auth.prf].call calls nope, which auth/Prf does not export"]
    );
}

#[test]
fn caller_type_may_be_a_struct_or_a_new_type_but_not_an_alias_or_missing() {
    let tag = run(&format!(
        "caller_type = {{ name = \"Tag\", module = \"who/Who\" }}\n{}",
        rule("\"list/Impl\"", "")
    ));
    assert_eq!(tag.names(), ["MockImplCaller"]);
    let missing = run(&format!(
        "caller_type = {{ name = \"Nope\", module = \"who/Who\" }}\n{}",
        rule("\"door/Door\"", "")
    ));
    assert_eq!(
        missing.errors(),
        ["[mock].caller_type: who/Who declares no struct or new type Nope"]
    );
}

#[test]
fn a_merged_group_wraps_every_circuit_and_exports_prefixed_pure_circuits() {
    let result = run(&rule(
        "\"math/Gen\"",
        "merge = true\ninit = \"none\"\nexclude = [\"initialize\"]\ninstances = [{ suffix = \"1\", prefix = \"U1_\", module_args = [\"1\"] }, { suffix = \"8\", prefix = \"U8_\", module_args = [\"8\"] }]\n",
    ));
    let plans = result.plans();
    let plan = &plans["MockGen"];
    assert_eq!(wrapper_names(plan), ["add1", "bump1", "add8", "bump8"]);
    assert_eq!(plan.exports, ["U1_add", "U8_add", "U1_total", "U8_total"]);
    assert!(plan.named.is_empty());
    assert_eq!(
        plan.prefixed,
        [
            ImportLine::Prefixed {
                path: "../../Gen".to_owned(),
                args: "<1>".to_owned(),
                prefix: "U1_".to_owned()
            },
            ImportLine::Prefixed {
                path: "../../Gen".to_owned(),
                args: "<8>".to_owned(),
                prefix: "U8_".to_owned()
            },
        ]
    );
}

#[test]
fn a_merged_constructor_shares_equal_parameters_and_appends_each_flag() {
    let result = run(&rule(
        "\"math/Gen\"",
        "instances = [{ suffix = \"2\", group = \"G\", prefix = \"Two_\", module_args = [\"2\"] }, { suffix = \"3\", group = \"G\", prefix = \"Three_\", module_args = [\"3\"], init = { flag = \"three\" } }]\n",
    ));
    let text = result.text("MockGenG");
    assert!(text.contains(
        "constructor(seed: Field, owner: Bytes<32>, three: Boolean) {\n  Two_initialize(seed, owner);\n  if (disclose(three)) {\n    Three_initialize(seed, owner);\n  }\n}"
    ), "{text}");
}

#[test]
fn merged_instances_with_one_argument_text_or_clashing_parameters_are_errors() {
    let same = run(&rule(
        "\"math/Gen\"",
        "merge = true\ninstances = [{ suffix = \"A\", module_args = [\"2\"] }, { suffix = \"B\", module_args = [\" 2 \"] }]\n",
    ));
    assert_eq!(
        same.errors(),
        [
            "MockGen: instances A and B pass the same module arguments < 2 >; compactc would share one instance of math/Gen"
        ]
    );
    let extra = (
        "math/Two.compact",
        "pragma language_version >= 0.28.0;\nmodule Two<#N> {\n  export circuit initialize(seed: Uint<N>): [] { }\n}\n",
    );
    let clash = run_with(
        &rule(
            "\"math/Two\"",
            "merge = true\ninstances = [{ suffix = \"A\", module_args = [\"1\"] }, { suffix = \"B\", module_args = [\"2\"] }]\n",
        ),
        &[extra],
        None,
        &[],
    );
    assert_eq!(
        clash.errors(),
        [
            "MockTwo: constructor parameter seed has type Uint<1> in instance A and Uint<2> in instance B"
        ]
    );
}

#[test]
fn a_generic_module_without_arguments_is_an_error_per_mock() {
    let result = run(&rule("\"math/Gen\"", ""));
    assert_eq!(
        result.errors()[0],
        "MockGen: math/Gen takes 1 generic arguments; set module_args or instances"
    );
}

#[test]
fn the_import_block_has_four_groups_in_order() {
    let result = run(&format!(
        "{CALLER}{PRF}{BLINDING}{}",
        rule(
            "\"door/Door\"",
            "auth = [\"prf\"]\ninject = [\"blinding\"]\nimplements = [{ name = \"Tally\", module = \"iface/Iface\" }]\nexclude = [\"peek\"]\n"
        )
    ));
    // `implements` fails the circuit check, so read the import groups from the errors.
    assert!(
        result.errors()[0].starts_with("MockDoor: implements Tally, but exposes no circuit get")
    );
    let ok = run(&format!(
        "{CALLER}{PRF}{BLINDING}{}",
        rule(
            "\"door/Door\"",
            "auth = [\"prf\"]\ninject = [\"blinding\"]\n"
        )
    ));
    let text = ok.text("MockDoor");
    let block: Vec<&str> = text
        .split("\n\n")
        .filter(|group| group.starts_with("import"))
        .collect();
    assert_eq!(block[0], "import CompactStandardLibrary;");
    assert!(
        block[1].starts_with("import {") && !block[1].contains(" prefix "),
        "{text}"
    );
    assert_eq!(
        block[2],
        "import \"../../../auth/Prf\" prefix Prf_;\nimport \"../../../rand/Rand\" prefix Rand_;\nimport \"../../Door\" prefix Door_;"
    );
}

#[test]
fn an_interface_is_imported_by_name_and_never_exported() {
    let result = run_with(
        &rule(
            "\"iface/Iface\"",
            "implements = [{ name = \"Tally\", module = \"iface/Iface\" }]\n",
        ),
        &[(
            "iface/test/MockIface.fragment.compact",
            "export circuit bump(n: Field): [] { }\n",
        )],
        None,
        &[],
    );
    let plans = result.plans();
    let plan = &plans["MockIface"];
    assert_eq!(plan.implements, ["Tally"]);
    assert_eq!(
        plan.interfaces,
        [ImportLine::Selective {
            names: vec!["Tally".to_owned()],
            path: "../../Iface".to_owned(),
            args: String::new()
        }]
    );
    assert!(!plan.exports.iter().any(|name| name.contains("Tally")));
    let text = render(plan);
    assert!(
        text.contains("contract implements Tally;\n\nexport {"),
        "{text}"
    );
    assert!(
        text.ends_with("include \"../MockIface.fragment\";\n"),
        "{text}"
    );
    let missing = run(&rule(
        "\"iface/Iface\"",
        "implements = [{ name = \"Tally\", module = \"iface/Iface\" }]\n",
    ));
    assert_eq!(
        missing.errors(),
        [
            "MockIface: implements Tally, but exposes no circuit bump; add it to src/iface/test/MockIface.fragment.compact"
        ]
    );
    let none = run(&rule(
        "\"iface/Iface\"",
        "implements = [{ name = \"Nope\", module = \"iface/Iface\" }]\n",
    ));
    assert_eq!(
        none.errors(),
        ["MockIface: implements Nope, but iface/Iface declares no exported contract Nope"]
    );
}

#[test]
fn an_export_list_circuit_that_needs_a_wrapper_is_spelled_from_its_declaring_file() {
    let result = run(&rule("\"list/Facade\"", "guard = [\"inner\"]\n"));
    let plans = result.plans();
    let plan = &plans["MockFacade"];
    let inner = &plan.wrappers[0];
    assert_eq!(inner.name, "inner");
    assert_eq!(inner.params[0].ty, "Tag");
    assert_eq!(inner.call.callee, "Facade_inner");
    assert!(plan.named.contains(&ImportLine::Selective {
        names: vec!["Tag".to_owned()],
        path: "../../../who/Who".to_owned(),
        args: String::new()
    }));
}

#[test]
fn a_witness_name_from_two_files_is_an_error_naming_both() {
    let result = run(&rule("\"clash/Clash\"", ""));
    assert_eq!(
        result.errors(),
        [
            "MockClash: witness secret is declared by both src/clash/Clash.compact and src/auth/Prf.compact; compactc binds both to one witness function. Remove one import or write the mock by hand"
        ]
    );
}

#[test]
fn the_same_witness_reached_twice_is_allowed() {
    let result = run(&format!(
        "{CALLER}{PRF}{BLINDING}{}",
        rule(
            "\"door/Door\"",
            "auth = [\"prf\"]\ninject = [\"blinding\"]\n"
        )
    ));
    assert!(result.errors().is_empty(), "{:?}", result.errors());
}

#[test]
fn plain_ledger_names_are_imported_by_name_and_exported_bare() {
    let result = run(&rule(
        "\"door/Door\"",
        "ledger_names = \"plain\"\nexclude = [\"open\", \"initialize\"]\ninit = \"none\"\n",
    ));
    let plans = result.plans();
    let plan = &plans["MockDoor"];
    assert!(
        plan.exports
            .ends_with(&["_salt".to_owned(), "opened".to_owned()])
    );
    let named = render(plan);
    assert!(
        named.contains("import { commit, peek, _salt, opened } from \"../../Door\";"),
        "{named}"
    );
}

#[test]
fn a_ledger_list_limits_the_exported_fields() {
    let result = run(&rule("\"door/Door\"", "ledger = [\"opened\"]\n"));
    assert!(
        result.plans()["MockDoor"]
            .exports
            .ends_with(&["Door_opened".to_owned()])
    );
}

#[test]
fn rule_level_names_must_exist_in_some_module_the_rule_applies_to() {
    let result = run(&rule(
        "\"door/Door\", \"over/Dial\"",
        "exclude = [\"peek\", \"nope\"]\nguard = [\"stop\"]\nledger = [\"_ghost\"]\n",
    ));
    assert_eq!(
        result.errors(),
        [
            "config compact.toml: [[mock.rules]] #1: exclude names nope, which no module the rule applies to exports",
            "config compact.toml: [[mock.rules]] #1: ledger names _ghost, which no module the rule applies to exports as a ledger field",
        ]
    );
    let init = run(&rule("\"over/Dial\"", "init = { flag = \"f\" }\n"));
    assert_eq!(
        init.errors(),
        [
            "config compact.toml: [[mock.rules]] #1: init = { flag = \"f\" }, but no module the rule applies to exports initialize"
        ]
    );
}

#[test]
fn a_rule_that_applies_to_no_module_is_a_note_not_an_error() {
    let result = run(&format!(
        "{}{}",
        rule("\"door/Door\"", ""),
        rule("\"dor/*\"", "")
    ));
    assert!(result.errors().is_empty(), "{:?}", result.errors());
    assert_eq!(
        result.analysis.notes,
        ["config compact.toml: [[mock.rules]] #2 applies to no module under src"]
    );
}

#[test]
fn a_rule_whose_modules_are_all_excluded_is_not_checked() {
    let result = run(&format!(
        "exclude = [\"math/*\"]\n{}{}",
        rule("\"door/Door\"", ""),
        rule(
            "\"math/Gen\"",
            "rename = { mix = \"blend\" }\nexclude = [\"nope\"]\n"
        )
    ));
    assert!(result.errors().is_empty(), "{:?}", result.errors());
    assert_eq!(
        result.analysis.notes,
        ["config compact.toml: [[mock.rules]] #2 applies to no module under src"]
    );
    let narrowed = run(&format!(
        "{}{}",
        rule("\"door/Door\"", ""),
        rule(
            "\"door/*\"",
            "exclude_modules = [\"door/Door\"]\nrename = { mix = \"blend\" }\n"
        )
    ));
    assert!(narrowed.errors().is_empty(), "{:?}", narrowed.errors());
}

#[test]
fn presets_and_modules_without_circuits_are_skipped_not_failed() {
    let result = run(&rule("\"presets/*\", \"empty/*\", \"over/*\"", ""));
    assert!(result.errors().is_empty());
    let skipped: Vec<(&str, &str)> = result
        .analysis
        .modules
        .iter()
        .filter_map(|module| match &module.status {
            Status::Skipped(reason) => Some((module.module.as_str(), reason.text())),
            _ => None,
        })
        .collect();
    assert_eq!(
        skipped,
        [
            ("empty/Empty", "no exported circuits"),
            ("presets/Preset", "not a module")
        ]
    );
}

#[test]
fn an_unresolved_parameter_type_fails_closed_when_caller_type_is_set() {
    let extra = (
        "lost/Lost.compact",
        "pragma language_version >= 0.28.0;\nmodule Lost {\n  import { Ghost } from \"./Missing\";\n  export circuit go(g: Ghost): [] { }\n}\n",
    );
    let result = run_with(
        &format!("{CALLER}{}", rule("\"lost/*\"", "")),
        &[extra],
        None,
        &[],
    );
    assert!(
        result.errors()[0].contains("does not resolve"),
        "{:?}",
        result.errors()
    );
}

#[test]
fn a_dir_scope_tolerates_a_failing_module_outside_it_but_not_a_config_error() {
    let table = rule("\"**\"", "");
    let failing = run_with(&table, &[], Some("src/over"), &[]);
    assert!(failing.errors().is_empty(), "{:?}", failing.errors());
    assert_eq!(failing.names(), ["MockDial"]);
    let whole = run_with(&table, &[], None, &[]);
    assert!(
        !whole.errors().is_empty(),
        "math/Gen without module_args fails a whole run"
    );
    let config_error = run_with(
        &format!("{table}{}", rule("\"over/Dial\"", "exclude = [\"nope\"]\n")),
        &[],
        Some("src/over"),
        &[],
    );
    assert_eq!(
        config_error.errors(),
        [
            "config compact.toml: [[mock.rules]] #2: exclude names nope, which no module the rule applies to exports"
        ]
    );
}

#[test]
fn a_name_filter_plans_only_the_named_mocks_and_rejects_an_unknown_one() {
    let table = format!(
        "{CALLER}{PRF}{}",
        rule("\"door/Door\"", "auth = [\"prf\", \"caller\"]\n")
    );
    assert_eq!(
        run_with(&table, &[], None, &["MockDoorCaller"]).names(),
        ["MockDoorCaller"]
    );
    assert_eq!(
        run_with(&table, &[], None, &["MockNope"]).errors(),
        ["no mock named MockNope in compact.toml"]
    );
}

#[test]
fn a_fragment_constructor_needs_init_none_and_its_circuits_count_as_exposed() {
    let fragment = (
        "over/test/MockDial.fragment.compact",
        "constructor() { }\nexport circuit extra(): [] { }\n",
    );
    let result = run_with(&rule("\"over/Dial\"", ""), &[fragment], None, &[]);
    let plans = result.plans();
    assert_eq!(
        plans["MockDial"].include.as_deref(),
        Some("../MockDial.fragment")
    );
    let fragment = ("door/test/MockDoor.fragment.compact", "constructor() { }\n");
    let result = run_with(&rule("\"door/Door\"", ""), &[fragment], None, &[]);
    assert_eq!(
        result.errors(),
        [
            "MockDoor: fragment src/door/test/MockDoor.fragment.compact declares a constructor; set init = \"none\""
        ]
    );
    let missing = run(&rule(
        "\"over/Dial\"",
        "include = \"Other.fragment.compact\"\n",
    ));
    assert_eq!(
        missing.errors(),
        ["MockDial: fragment src/over/test/Other.fragment.compact does not exist"]
    );
}

#[test]
fn the_constructor_is_auto_by_default_and_consumes_the_init_circuit() {
    let result = run(&rule("\"door/Door\"", ""));
    let plans = result.plans();
    let plan = &plans["MockDoor"];
    let constructor = plan.constructor.as_ref().expect("a constructor");
    assert_eq!(constructor.calls[0].1.callee, "Door_initialize");
    assert!(!render(plan).contains("export circuit initialize"));
    let none = run(&rule("\"door/Door\"", "init = \"none\"\n"));
    assert!(none.plans()["MockDoor"].constructor.is_none());
    assert!(none.text("MockDoor").contains("initialize"));
}

#[test]
fn every_mock_is_byte_identical_across_runs() {
    let table = format!(
        "{CALLER}{PRF}{BLINDING}{}",
        rule(
            "\"door/Door\"",
            "auth = [\"prf\", \"caller\"]\ninject = [\"blinding\"]\n"
        )
    );
    let first = run(&table);
    let second = run(&table);
    for (name, plan) in first.plans() {
        let text = render(&plan);
        assert_eq!(text, render(&second.plans()[&name]), "{name}");
        assert!(text.ends_with("}\n") && !text.ends_with("\n\n"));
        assert!(text.contains("FOR TESTING PURPOSES ONLY"));
    }
}

#[test]
fn every_output_path_lies_under_an_artifacts_directory() {
    let result = run(&format!(
        "{CALLER}{PRF}{}",
        rule(
            "\"**\"",
            "auth = [\"prf\", \"caller\"]\nexclude_modules = [\"math/Gen\", \"clash/*\"]\n"
        )
    ));
    for plan in result.plans().values() {
        assert!(
            plan.path.starts_with(&plan.artifacts),
            "{}",
            plan.path.display()
        );
        assert!(plan.artifacts.ends_with(Path::new("test/artifacts")));
    }
}

const TRAP: (&str, &str) = (
    "trap/Trap.compact",
    "pragma language_version >= 0.28.0;\nmodule Trap<T> {\n  import { Caller } from \"../who/Who\";\n  export circuit initialize(c: Maybe<Caller>): [] { }\n  export circuit swap(a: Caller, b: Caller): [] { }\n  export circuit wrap(c: Maybe<Caller>): [] { }\n  export circuit gen<U>(x: U): [] { }\n  export circuit ok(c: Caller): [] { }\n}\n",
);

#[test]
fn an_authenticated_mock_fails_closed_on_every_caller_it_cannot_inject() {
    let result = run_with(
        &format!(
            "{CALLER}{PRF}params = [\"caller\", \"a\", \"b\"]\n{}",
            rule(
                "\"trap/Trap\"",
                "auth = [\"prf\"]\nmodule_args = [\"Caller\"]\ncircuit_args = { gen = [\"Maybe<Caller>\"] }\n"
            )
        ),
        &[TRAP],
        None,
        &[],
    );
    assert_eq!(
        result.errors(),
        [
            "MockTrap: module_args sets a type parameter to Caller, which is or contains Caller, so the mock could take a caller it does not authenticate; write the mock by hand",
            "MockTrap: swap takes 2 Caller parameters, and the authenticated mock would pass one caller to all of them; add swap to exclude, or use the caller mock",
            "MockTrap: parameter c of wrap has type Maybe<Caller>, which contains Caller but is not it; add wrap to exclude",
            "MockTrap: circuit_args.gen sets a type parameter to Maybe<Caller>, which is or contains Caller, so the mock could take a caller it does not authenticate; add gen to exclude",
            "MockTrap: parameter c of initialize has type Maybe<Caller>, which contains Caller but is not it; set init = \"none\" and add initialize to exclude",
        ]
    );
}

#[test]
fn the_caller_mock_keeps_every_caller_parameter_and_raises_no_injection_error() {
    let result = run_with(
        &format!(
            "{CALLER}{PRF}{}",
            rule(
                "\"trap/Trap\"",
                "auth = [\"caller\"]\nmodule_args = [\"Field\"]\ncircuit_args = { gen = [\"Field\"] }\n"
            )
        ),
        &[TRAP],
        None,
        &[],
    );
    let plans = result.plans();
    let text = render(&plans["MockTrapCaller"]);
    assert!(
        text.contains("import { swap, wrap, ok } from \"../../Trap\"<Field>;"),
        "{text}"
    );
    assert!(!text.contains("Prf_"));
}

#[test]
fn circuit_args_must_target_a_generic_circuit_with_the_right_count() {
    let result = run(&rule(
        "\"math/Gen\"",
        "module_args = [\"4\"]\ncircuit_args = { bump = [\"Field\"], initialize = [\"1\", \"2\"] }\n",
    ));
    assert_eq!(
        result.errors(),
        [
            "MockGen: circuit_args.bump: bump has no type parameters",
            "MockGen: circuit_args.initialize: initialize has no type parameters",
        ]
    );
    let generic = run_with(
        &rule(
            "\"trap/Trap\"",
            "module_args = [\"Field\"]\ncircuit_args = { gen = [\"Field\", \"Field\"] }\n",
        ),
        &[TRAP],
        None,
        &[],
    );
    assert_eq!(
        generic.errors(),
        ["MockTrap: circuit_args.gen has 2 arguments; gen takes 1"]
    );
}

#[test]
fn each_transform_forces_a_wrapper_and_only_injection_or_guard_drops_pure() {
    let result = run(&rule(
        "\"door/Door\"",
        "disclose = [\"commit\", \"peek\"]\nguard = [\"open\"]\nrename = { open = \"enter\" }\n",
    ));
    let plans = result.plans();
    let plan = &plans["MockDoor"];
    let shape: Vec<(&str, &str, bool, bool, bool)> = plan
        .wrappers
        .iter()
        .map(|wrapper| {
            (
                wrapper.name.as_str(),
                wrapper.call.callee.as_str(),
                wrapper.pure,
                wrapper.guard,
                wrapper.disclose,
            )
        })
        .collect();
    assert_eq!(
        shape,
        [
            ("enter", "Door_open", false, true, false),
            ("commit", "Door_commit", false, false, true),
            ("peek", "Door_peek", true, false, true),
        ]
    );
    assert!(plan.guard_ledger);
    let text = render(plan);
    assert!(text.contains("ledger _invocations: Counter;"));
    assert!(
        text.contains("  _invocations.increment(1);\n  return Door_open(caller, blinding, n);")
    );
    assert_eq!(text.matches("disclose(").count(), 2, "{text}");
    assert!(!text.contains("export circuit open("));
}

#[test]
fn disclose_wraps_only_listed_calls_and_each_constructor_flag() {
    let result = run(&rule(
        "\"door/Door\"",
        "disclose = [\"commit\"]\ninit = { flag = \"ready\" }\n",
    ));
    let text = result.text("MockDoor");
    assert_eq!(text.matches("disclose(").count(), 2, "{text}");
    assert!(text.contains("if (disclose(ready)) {"));
    assert!(text.contains("return disclose(Door_commit(blinding));"));
}

#[test]
fn an_excluded_init_circuit_the_constructor_calls_still_counts_as_covered() {
    let result = run(&rule("\"door/Door\"", "exclude = [\"initialize\"]\n"));
    let plans = result.plans();
    let plan = &plans["MockDoor"];
    assert!(plan.constructor.is_some());
    assert!(plan.covered.contains(&0), "{:?}", plan.covered);
}

#[test]
fn an_interface_used_in_a_signature_is_imported_once() {
    let user = (
        "iface/User.compact",
        "pragma language_version >= 0.28.0;\nmodule User {\n  import { Tally } from \"./Iface\";\n  export circuit get(): Field { return 0; }\n  export circuit bump(n: Field): [] { }\n  export circuit poke(t: Tally): [] { }\n}\n",
    );
    let result = run_with(
        &rule(
            "\"iface/User\"",
            "guard = [\"poke\"]\nimplements = [{ name = \"Tally\", module = \"iface/Iface\" }]\n",
        ),
        &[user],
        None,
        &[],
    );
    let text = result.text("MockUser");
    assert_eq!(text.matches("import { Tally }").count(), 1, "{text}");
}

#[test]
fn a_salt_is_checked_only_where_the_mock_injects_a_caller() {
    let result = run(&format!(
        "{CALLER}{PRF}{}",
        rule(
            "\"door/Door\"",
            "auth = [\"prf\"]\nexclude = [\"open\", \"initialize\"]\ninit = \"none\"\nsalt = \"a salt far longer than the thirty-two bytes pad takes\"\n"
        )
    ));
    assert!(result.errors().is_empty(), "{:?}", result.errors());
    assert!(!result.text("MockDoor").contains("Prf_"));
}
