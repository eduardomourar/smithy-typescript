const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

const pkgJson = require(path.join(root, "package.json"));
const tsconfigs = {
  cjs: require(path.join(root, "tsconfig.cjs.json")),
  es: require(path.join(root, "tsconfig.es.json")),
  types: require(path.join(root, "tsconfig.types.json")),
};
const submodules = fs.readdirSync(path.join(root, "src", "submodules"));

const errors = [];

for (const submodule of submodules) {
  const submodulePath = path.join(root, "src", "submodules", submodule);
  if (fs.existsSync(submodulePath) && fs.lstatSync(submodulePath).isDirectory()) {
    // package.json metadata.
    if (!pkgJson.exports[`./${submodule}`]) {
      errors.push(`${submodule} submodule is missing exports statement in package.json`);
      pkgJson.exports[`./${submodule}`] = {
        types: `./dist-types/submodules/${submodule}/index.d.ts`,
        module: `./dist-es/submodules/${submodule}/index.js`,
        node: `./dist-cjs/submodules/${submodule}/index.js`,
        import: `./dist-es/submodules/${submodule}/index.js`,
        require: `./dist-cjs/submodules/${submodule}/index.js`,
      };
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n");
    }
    if (!pkgJson.files.includes(`./${submodule}.js`) || !pkgJson.files.includes(`./${submodule}.d.ts`)) {
      pkgJson.files.push(`./${submodule}.js`);
      pkgJson.files.push(`./${submodule}.d.ts`);
      errors.push(`package.json files array missing ${submodule}.js compatibility redirect file.`);
      pkgJson.files = [...new Set(pkgJson.files)].sort();
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n");
    }
    // tsconfig metadata.
    for (const [kind, tsconfig] of Object.entries(tsconfigs)) {
      if (!tsconfig.compilerOptions.paths?.[`@smithy/core/${submodule}`]) {
        errors.push(`${submodule} submodule is missing paths entry in tsconfig.${kind}.json`);

        tsconfig.compilerOptions.paths[`@smithy/core/${submodule}`] = [`./src/submodules/${submodule}/index.ts`];
        fs.writeFileSync(path.join(root, `tsconfig.${kind}.json`), JSON.stringify(tsconfig, null, 2) + "\n");
      }
    }
    // compatibility redirect file.
    const compatibilityRedirectFile = path.join(root, `${submodule}.js`);
    if (!fs.existsSync(compatibilityRedirectFile)) {
      errors.push(`${submodule} is missing compatibility redirect file in the package root folder.`);
      fs.writeFileSync(
        compatibilityRedirectFile,
        `
/**
 * Do not edit:
 * This is a compatibility redirect for contexts that do not understand package.json exports field.
 */
module.exports = require("./dist-cjs/submodules/${submodule}/index.js");
`
      );
    }
    // compatibility types file.
    const compatibilityTypesFile = path.join(root, `${submodule}.d.ts`);
    if (!fs.existsSync(compatibilityTypesFile)) {
      errors.push(`${submodule} is missing compatibility types file in the package root folder.`);
      fs.writeFileSync(
        compatibilityTypesFile,
        `
/**
 * Do not edit:
 * This is a compatibility redirect for contexts that do not understand package.json exports field.
 */
declare module "@smithy/core/${submodule}" {
  export * from "@smithy/core/dist-types/submodules/${submodule}/index.d";
}
`
      );
    }
  }
}

/**
 * Check for cross-submodule relative imports.
 */

const walk = require("../../../scripts/utils/walk");

(async () => {
  for await (const item of walk(path.join(root, "src", "submodules"))) {
    // depth within the submodule where 1 is at the root of the submodule.
    const depth = item.split("core/src/submodules/")[1].split("/").length - 1;
    const sourceCode = fs.readFileSync(item, "utf-8");

    const relativeImports = [];
    relativeImports.push(
      ...new Set(
        [...(sourceCode.toString().match(/(from |import\()"(.*?)";/g) || [])]
          .map((_) => _.replace(/from "/g, "").replace(/";$/, ""))
          .filter((_) => _.startsWith("."))
      )
    );

    for (const i of relativeImports) {
      const relativeImportDepth = i.split("..").length - 1;
      if (relativeImportDepth >= depth) {
        errors.push(
          `relative import ${i} in ${item
            .split("packages/")
            .pop()} crosses submodule boundaries. Use @scope/package/submodule import instead.`
        );
      }
    }

    const subModuleImports = [
      ...new Set(
        (sourceCode.toString().match(/(from |import\()"\@smithy\/core\/(.*?)";/g) || []).map(
          (_) => _.match(/@smithy\/core\/(.*?)"/)[1]
        )
      ),
    ];
    const ownModule = item.match(/src\/submodules\/(.*?)\//)?.[1];

    if (subModuleImports.includes(ownModule)) {
      errors.push(`self-referencing submodule import found in ${item}`);
    }
  }
})().then(() => {
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
});
