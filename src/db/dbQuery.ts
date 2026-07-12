import pg from 'pg';
import { db } from "../config";

const Pool = pg.Pool;

const pool = new Pool({
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    keepAlive: true,
    user: db.user,
    port: db.port ? parseInt(db.port): 5432,
    host: db.host,
    database: db.database,
    password: db.password
})

export { pool };

export default {
    /**
     * DB Query
     * @param {object} req
     * @param {object} res
     * @returns {object} object
     */
     
    query(queryText: string, params?: any): Promise<any> {
        return new Promise((resolve, reject) => {
            pool.query(queryText, params)
                .then((res) => {
                    resolve(res);
                })
                .catch((err) => {
                    console.log(err);
                    reject(err);
                })
        })
    }
}