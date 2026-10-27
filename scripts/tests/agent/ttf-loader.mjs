export async function load(url, context, nextLoad) {
  if (url.includes('.ttf')) {
    return {
      format: 'module',
      shortCircuit: true,
      source: 'export default "";',
    };
  }
  return nextLoad(url, context);
}
