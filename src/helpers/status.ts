const successMessage: { status: string, data?: any } = { status: 'success' };
const errorMessage: { status: string, error?: any } = { status: 'error' };
const status = {
    success: 200,
    error: 500,
    notfound: 404,
    unauthorized: 401,
    conflict: 409,
    created: 201,
    bad: 400,
    nocontent: 204
};

export {
    successMessage,
    errorMessage,
    status
};