"""Run only from a trusted administrator machine with DATABASE_URL set."""
import os,sys,psycopg
if len(sys.argv)!=2: raise SystemExit('Usage: python scripts/promote_researcher.py researcher@example.com')
with psycopg.connect(os.environ['DATABASE_URL']) as conn:
    with conn.cursor() as cur:
        cur.execute("UPDATE users SET role='researcher' WHERE email=%s RETURNING email",(sys.argv[1].lower(),))
        if not cur.fetchone(): raise SystemExit('Account not found: user must register first')
print('Researcher access granted')
