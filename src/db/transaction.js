module.exports = async function transaction(db, action) {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const result = await action(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally { client.release(); }
};
