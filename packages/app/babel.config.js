const path = require("node:path");

const generatedOutboundValidator = path.resolve(
  __dirname,
  "../protocol/dist/generated/validation/ws-outbound.aot.js",
);

module.exports = function (api) {
  api.cache(true);

  const expoPreset = [
    "babel-preset-expo",
    {
      // Transform `import.meta` for ALL platforms (web + native)
      // Required for modern ESM deps like Zustand 5 that use import.meta.env
      unstable_transformImportMeta: true,
      // Preserve the compiler's node_modules gate and skip generated non-React validation.
      "react-compiler": {
        sources: (filename) =>
          !filename.includes("node_modules") && filename !== generatedOutboundValidator,
      },
    },
  ];

  return {
    presets: [expoPreset],
    plugins: [
      [
        "react-native-unistyles/plugin",
        {
          root: "src",
        },
      ],
    ],
  };
};
