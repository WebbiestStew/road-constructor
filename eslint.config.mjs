import nextConfig from "eslint-config-next";

const eslintConfig = [
  ...nextConfig,
  {
    ignores: ["src/sim/worker.ts"],
  },
];

export default eslintConfig;
