const waitPort = require('wait-port');
const fs = require('fs');
const { Pool } = require('pg');

const {
    POSTGRES_HOST: HOST,
    POSTGRES_HOST_FILE: HOST_FILE,
    POSTGRES_USER: USER,
    POSTGRES_USER_FILE: USER_FILE,
    POSTGRES_PASSWORD: PASSWORD,
    POSTGRES_PASSWORD_FILE: PASSWORD_FILE,
    POSTGRES_DB: DB,
    POSTGRES_DB_FILE: DB_FILE,
    POSTGRES_PORT: PORT,
} = process.env;

let pool;

async function init() {
    const host = HOST_FILE ? fs.readFileSync(HOST_FILE, 'utf8').trim() : HOST;
    const user = USER_FILE ? fs.readFileSync(USER_FILE, 'utf8').trim() : USER;
    const password = PASSWORD_FILE ? fs.readFileSync(PASSWORD_FILE, 'utf8').trim() : PASSWORD;
    const database = DB_FILE ? fs.readFileSync(DB_FILE, 'utf8').trim() : DB;
    const port = PORT || 5432;

    await waitPort({
        host,
        port: Number(port),
        timeout: 10000,
        waitForDns: true,
    });

    pool = new Pool({
        host,
        user,
        password,
        database,
        port,
        max: 5,
    });

    return new Promise((acc, rej) => {
        pool.query(
            'CREATE TABLE IF NOT EXISTS todo_items (id varchar(36), name varchar(255), completed boolean)',
            err => {
                if (err) return rej(err);
                console.log(`Connected to postgres db at host ${host}`);
                acc();
            },
        );
    });
}

async function teardown() {
    return pool.end();
}

async function getItems() {
    const { rows } = await pool.query('SELECT * FROM todo_items');
    return rows;
}

async function getItem(id) {
    const { rows } = await pool.query('SELECT * FROM todo_items WHERE id=$1', [id]);
    return rows[0];
}

async function storeItem(item) {
    await pool.query(
        'INSERT INTO todo_items (id, name, completed) VALUES ($1, $2, $3)',
        [item.id, item.name, item.completed],
    );
}

async function updateItem(id, item) {
    await pool.query(
        'UPDATE todo_items SET name=$1, completed=$2 WHERE id=$3',
        [item.name, item.completed, id],
    );
}

async function removeItem(id) {
    await pool.query('DELETE FROM todo_items WHERE id = $1', [id]);
}

module.exports = {
    init,
    teardown,
    getItems,
    getItem,
    storeItem,
    updateItem,
    removeItem,
};