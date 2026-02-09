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
  
  export {
    idGenerator,
    randomFixedInteger
  }
  