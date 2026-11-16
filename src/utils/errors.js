export function fail(status, code) {
  return Object.assign(new Error(code), { status, code });
}
