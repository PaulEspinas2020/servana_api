const { randomInt } = require('crypto')

const idGenerator = (length: number, prefix: string) => {
    const year = new Date().getFullYear().toString().slice(-2)
    return `${prefix}-${year}-${randomFixedInteger(length)}`
  }
  
  // C19 §13. Was Math.random(). These ids are not secrets, but they are
  // user-visible references, and a predictable sequence makes them guessable.
  // randomInt costs nothing here and removes the question entirely. Same
  // digit-length output as before.
  const randomFixedInteger = (length: number) => {
    const min = Math.pow(10, length - 1)
    const max = Math.pow(10, length)
    return randomInt(min, max)
  }
  
  const toCamel = (row: any) => {
  const newRow: any = {};
  Object.keys(row).forEach((key) => {
    const camelKey = key.replace(/_([a-z0-9])/g, (g) => g[1].toUpperCase());
    newRow[camelKey] = row[key];
  });
  return newRow;
};

  export {
    idGenerator,
    randomFixedInteger,
    toCamel
  }
  