const path = require('path');
const webpack = require('webpack');
const nodeExternals = require('webpack-node-externals');

module.exports = function (options) {
  return {
    ...options,
    target: 'node',
    externals: [
      nodeExternals({
        allowlist: [/^@app/],
        modulesDir: path.resolve(process.cwd(), 'node_modules'),
      }),
      {
        crypto: 'commonjs crypto',
        express: 'commonjs express',
      },
    ],
    resolve: {
      ...options.resolve,
      modules: [
        path.resolve(process.cwd(), 'node_modules'),
        ...(options.resolve?.modules || ['node_modules']),
      ],
      fallback: {
        ...options.resolve?.fallback,
        crypto: false,
      },
    },
    plugins: [
      ...options.plugins,
      new webpack.ProvidePlugin({
        Buffer: ['buffer', 'Buffer'],
      }),
    ],
  };
};
