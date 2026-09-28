// Compiles the game simulation (sim-server.c, the offline rules extended for many
// players) to native machine code and links it into the server.
fn main() {
    println!("cargo:rerun-if-changed=sim-server.c");
    let mut b = cc::Build::new();
    b.file("sim-server.c").opt_level(3).flag_if_supported("-Wno-misleading-indentation");
    // Tune for the CPU it is built on (the server builds itself). SERPENT_PORTABLE=1 to skip.
    if std::env::var("SERPENT_PORTABLE").is_err() {
        b.flag_if_supported("-march=native");
    }
    b.compile("sim");
}
