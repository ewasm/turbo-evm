const gulp = require("gulp")
const fs = require("fs")
const wabt = require("wabt")()
const asc = require("assemblyscript/bin/asc")

/**
 * A bunch of magic happens below to merge functions from a wat file
 * into the assemblyscript output wasm.
 *
 * The `ImportStatementToDelete` is a config setting that you might
 * have to update if the `export declare function keccak(...)`
 * is moved between different files.
 * 
 * If you change something and AS uses a different imported name,
 * don't forget to edit the entry function in keccak-funcs.wat
 * so that it matches. see the line near the bottom:
 *   (func $keccak/keccak ;; this name needs to match what assemblyscript generates
 * 
 */

const ImportStatementToDelete = '(import "watimports" "$ethash_keccak256" (func $assembly/keccak/ethash_keccak256 (param i32 i32 i32)))'

/*
  Runtime variants:
  "--runtime", "full" (default)
    A proper memory manager and reference-counting based garbage collector, with runtime interfaces
    being exported to the host for being able to create managed objects externally.
  "--runtime", "half"
    The same as full but without any exports, i.e. where creating objects externally is not required.
    This allows the optimizer to eliminate parts of the runtime that are not needed.
  "--runtime", "stub"
    A minimalist arena memory manager without any means of freeing up memory again, but the same external
    interface as full. Useful for very short-lived programs or programs with hardly any memory footprint,
    while keeping the option to switch to full without any further changes. No garbage collection.
  "--runtime", "none"
    The same as stub but without any exports, for the same reasons as explained in half. Essentially
    evaporates entirely after optimizations.
    For more information see: https://docs.assemblyscript.org/details/runtime
*/
//gulp.task("build", callback => {
async function build() {
  console.log('gulp.js build task..')
  await buildEvm()
  await buildToken()
}

async function buildEvm() {
  await compileEvm()
  mergeWats('evm', 'evm_with_keccak')
}

function compileEvm() {
  return new Promise((resolve, reject) => {
    asc.main([
      "assembly/main.ts",
      //"--baseDir", "assembly",
      "--binaryFile", "build/evm.wasm",
      "--textFile", "build/evm.wat",
      "--sourceMap",
      "--measure",
      "--runtime", "none",
      "--use", "abort=",
      "--memoryBase", "10000",
      "--optimize"
    ], (res) => {
      console.log("ascDone res:", res)
      if (res) {
        return reject(new Error('AssemblyScript error'))
      }
      return resolve()
    })
  })
}

async function buildToken() {
  await compileToken()
  mergeWats('token', 'token_with_keccak')
}

function compileToken() {
  return new Promise((resolve, reject) => {
    asc.main([
      "assembly/token.ts",
      //"--baseDir", "assembly",
      "--binaryFile", "build/token.wasm",
      "--textFile", "build/token.wat",
      "--sourceMap",
      "--measure",
      "--runtime", "none",
      "--use", "abort=",
      "--memoryBase", "10000",
      "--optimize"
    ], (res) => {
      console.log("ascDone res:", res)
      if (res) {
        return reject(new Error('AssemblyScript error'))
      }
      return resolve()
    })
  })
}

function mergeWats(inputName, outputName) {
  console.log('wabt:', wabt);

  //const utils = require("@wasm/studio-utils");
  //console.log("loading src/ethash_keccak_funcs.wat...");
  //const keccakWat = utils.project.getFile("src/ethash_keccak_funcs.wat").getData();
  const keccakWat = fs.readFileSync("assembly/src/ethash_keccak_funcs.wat", "utf8");
  //console.log("loaded keccak wat:", keccakWat);
  const keccakLines = keccakWat.split("\n")


  // wabt wat parsing might file on out/main.wat, but works if the wat doesn't names
  console.log(`loading build/${inputName}.wat...`);
  //const mainWat = utils.project.getFile("out/main.wat").getData();
  const mainWat = fs.readFileSync(`build/${inputName}.wat`, "utf8");

  /*
    const mainWasm = fs.readFileSync("out/main.wasm", "binary");
    var mainModule = wabt.readWasm(mainWasm, {readDebugNames: true});
    mainModule.validate();
    console.log('mainModule is valid.');
// the wat code needs to call keccak256 using names, because the regex below will replace the import with a function of the same name
    mainModule.resolveNames();
    mainModule.generateNames()
    mainModule.applyNames();

    const mainWat = mainModule.toText({});
    */

  // remove commas from function names generated by binaryen to please wabt
  let mainWatReplaced = mainWat.replace(/Uint\d+Array,/g, "Uint64Array");
  //console.log('mainWatReplaced:', mainWatReplaced)
  mainWatReplaced = mainWatReplaced.replace(/Map<usize,/g, "Map<usize");
  //console.log('mainWatReplaced:', mainWatReplaced)
  mainWatReplaced = mainWatReplaced.replace(/Uint\d+Array \| null/g, "UintArrayOrNull");

  var mainLines = mainWatReplaced.split("\n");
  console.log("main wat line count:", mainLines.length);
  // mainLines.length is 915
  // mainLines[0] is `(module`
  // mainLines[913] is is the closing paren `)`
  // mainLines[914] is an empty line ``
  // closing paren is second to last line

  var closing_paren_ix = mainLines.length - 2;

  // insert keccak functions wat code just before the last closing paren
  mainLines.splice(closing_paren_ix, 0, ...keccakLines);

  console.log('mainLines with keccak inserted:', mainLines.length);

  // now delete the import statement
  console.log("searching for import statement to delete...");

  var foundImport = false;
  for (var i=0; i<30; i++) {
    console.log(mainLines[i]);
    if (mainLines[i].trim() === ImportStatementToDelete) {
      console.log("found import statement!! deleting it...");
      mainLines.splice(i, 1);
      foundImport = true;
      break;
    }
  }

  if (!foundImport) {
    console.log("ERROR!! Couldn't find keccak import statement! wat parsing will probably fail.");
  }

  console.log('mainLines after deleting import statement:', mainLines.length);

  var merged_wat = mainLines.join("\n");
  fs.writeFileSync(`build/${outputName}_merged.wat`, merged_wat);

  var features = {'mutable_globals':false};
  var myModule = wabt.parseWat(`${outputName}.wat`, mainLines.join("\n"), features);
  console.log('parsed merged wat..');
  myModule.resolveNames();
  console.log('names resolved...');
  myModule.validate();
  console.log('myModule validated!!');
  let binary_result = myModule.toBinary({ write_debug_names: true });
  //console.log('binary_result:', binary_result);

  //var wasm_output = utils.project.newFile("out/main_with_keccak.wasm", "wasm");
  //wasm_output.setData(binary_result.buffer);
  fs.writeFileSync(`build/${outputName}.wasm`, binary_result.buffer);

  console.log('done merging wat codes.');
}

exports.build = build
exports.default = build
exports.token = buildToken
exports.evm = buildEvm
