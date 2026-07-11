const idGenerator = (length: number, prefix: string) => {
    const year = new Date().getFullYear().toString().slice(-2)
    return `${prefix}-${year}-${randomFixedInteger(length)}`
  }
  
  const randomFixedInteger = (length: number) => {
    return Math.floor(
      Math.pow(10, length - 1) +
        Math.random() * (Math.pow(10, length) - Math.pow(10, length - 1) - 1)
    )
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
  