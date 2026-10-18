# Source network filters

The desktop loads `network.bin` once per process. It contains network rules from EasyList and EasyPrivacy. It does not download lists or inject page scripts at runtime.

`manifest.json` records the upstream URLs, versions, commits, and source hashes. The compressed source snapshots allow offline regeneration.

Run `node scripts/update-source-filters.mjs --check` to verify the bundle. Run the command without arguments to regenerate it from the checked-in snapshots. Use `--refresh` to download current upstream lists and update the snapshots, manifest, and compiled bundle. Review the resulting filter changes and run the source network tests before shipping them.

The EasyList authors at https://easylist.to/ provide both lists. The bundled lists and compiled filter data use CC BY-SA 3.0, one of the licenses offered by https://easylist.to/pages/licence.html. The full license is in `LICENSE-CC-BY-SA-3.0.txt`. The Ghostery engine uses MPL 2.0; its packaged npm dependency includes that license.
