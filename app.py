import os, re, uuid, secrets, hashlib
from datetime import datetime, timedelta, timezone
from functools import wraps
from flask import Flask, render_template, request, jsonify, session, abort
from werkzeug.security import generate_password_hash, check_password_hash
import psycopg
from psycopg.rows import dict_row
import boto3
from botocore.config import Config

app = Flask(__name__)
app.config.update(SECRET_KEY=os.getenv('SECRET_KEY', secrets.token_hex(32)), SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SECURE=os.getenv('APP_ENV')=='production', SESSION_COOKIE_SAMESITE='Lax', PERMANENT_SESSION_LIFETIME=timedelta(hours=12), MAX_CONTENT_LENGTH=128*1024)
if os.getenv('APP_ENV') == 'production' and (not os.getenv('SECRET_KEY') or not os.getenv('DATABASE_URL')):
    raise RuntimeError('Production requires SECRET_KEY and DATABASE_URL')

def db():
    return psycopg.connect(os.environ['DATABASE_URL'], row_factory=dict_row, connect_timeout=8)

def query(sql, params=(), one=False):
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            if cur.description:
                return cur.fetchone() if one else cur.fetchall()

def fail(message, status=400): return jsonify(error=message), status

def require(role=None):
    def deco(fn):
        @wraps(fn)
        def inner(*args, **kwargs):
            if not session.get('uid'): return fail('Sign in required',401)
            if role and session.get('role') != role: return fail('Forbidden',403)
            return fn(*args, **kwargs)
        return inner
    return deco

@app.before_request
def csrf():
    if request.method in ('POST','PUT','PATCH','DELETE') and request.path.startswith('/api/'):
        if not secrets.compare_digest(request.headers.get('X-CSRF-Token',''), session.get('csrf','not-set')):
            return fail('Invalid CSRF token',403)

@app.after_request
def headers(resp):
    resp.headers['X-Content-Type-Options']='nosniff'
    resp.headers['Referrer-Policy']='no-referrer'
    resp.headers['X-Frame-Options']='DENY'
    resp.headers['Permissions-Policy']='camera=(), microphone=(), geolocation=()'
    resp.headers['Content-Security-Policy']="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    resp.headers['Cache-Control']='no-store' if request.path.startswith('/api/') else 'private, max-age=0'
    if os.getenv('APP_ENV')=='production': resp.headers['Strict-Transport-Security']='max-age=31536000; includeSubDomains'
    return resp

@app.get('/')
def index():
    session.setdefault('csrf',secrets.token_urlsafe(32))
    return render_template('index.html')

@app.get('/api/session')
def current():
    session.setdefault('csrf',secrets.token_urlsafe(32))
    return jsonify(csrf=session['csrf'], user={'id':session['uid'],'name':session['name'],'role':session['role']} if session.get('uid') else None)

@app.post('/api/register')
def register():
    d=request.get_json(silent=True) or {}; email=str(d.get('email','')).strip().lower(); name=str(d.get('name','')).strip(); password=str(d.get('password',''))
    if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',email) or not 2<=len(name)<=80 or len(password)<12 or len(password)>256: return fail('Provide a name, valid email and password of at least 12 characters')
    try:
        row=query('INSERT INTO users (email,name,password_hash,role) VALUES (%s,%s,%s,%s) RETURNING id,email,name,role',(email,name,generate_password_hash(password,method='scrypt'),'user'),True)
    except psycopg.errors.UniqueViolation: return fail('Account already exists',409)
    session.clear(); session.update(uid=str(row['id']),name=row['name'],role=row['role'],csrf=secrets.token_urlsafe(32)); return jsonify(user={'name':row['name'],'role':row['role']},csrf=session['csrf']),201

@app.post('/api/login')
def login():
    d=request.get_json(silent=True) or {}; email=str(d.get('email','')).strip().lower(); password=str(d.get('password',''))
    if len(email)>254 or len(password)>256: return fail('Invalid credentials',401)
    key=hashlib.sha256((request.remote_addr or 'unknown').encode()).hexdigest()
    try:
        count=query("SELECT count(*) AS n FROM login_attempts WHERE (ip_hash=%s OR email=%s) AND created_at > now()-interval '15 minutes'",(key,email),True)['n']
        if count>=10: return fail('Too many attempts. Try again later.',429)
        user=query('SELECT id,name,role,password_hash FROM users WHERE email=%s AND active=true',(email,),True)
        valid=bool(user and check_password_hash(user['password_hash'],password))
        query('INSERT INTO login_attempts (ip_hash,email,success) VALUES (%s,%s,%s)',(key,email,valid))
    except Exception: raise
    if not valid: return fail('Invalid credentials',401)
    session.clear(); session.update(uid=str(user['id']),name=user['name'],role=user['role'],csrf=secrets.token_urlsafe(32)); return jsonify(user={'name':user['name'],'role':user['role']},csrf=session['csrf'])

@app.post('/api/logout')
def logout(): session.clear(); return jsonify(ok=True)

@app.get('/api/observations')
@require()
def observations():
    if session['role']=='researcher':
        rows=query('SELECT o.id,o.species,o.notes,o.status,o.created_at,o.media_type,u.name AS contributor FROM observations o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 100')
    else:
        rows=query('SELECT id,species,notes,status,created_at,media_type FROM observations WHERE user_id=%s ORDER BY created_at DESC LIMIT 100',(session['uid'],))
    return jsonify(items=rows)

def s3():
    required=['S3_ENDPOINT','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY','S3_BUCKET']
    if any(not os.getenv(x) for x in required): raise RuntimeError('Private object storage not configured')
    return boto3.client('s3',endpoint_url=os.environ['S3_ENDPOINT'],aws_access_key_id=os.environ['S3_ACCESS_KEY_ID'],aws_secret_access_key=os.environ['S3_SECRET_ACCESS_KEY'],region_name=os.getenv('S3_REGION','auto'),config=Config(signature_version='s3v4'))

@app.post('/api/uploads/prepare')
@require('user')
def prepare():
    d=request.get_json(silent=True) or {}; mime=d.get('content_type'); size=d.get('size'); allowed={'image/jpeg','image/png','image/webp','video/mp4','video/webm'}
    if mime not in allowed or type(size)!=int or not 0<size<=50*1024*1024: return fail('Supported JPG, PNG, WebP, MP4 or WebM up to 50 MB')
    kind='video' if mime.startswith('video/') else 'image'; oid=str(uuid.uuid4()); key=f"observations/{session['uid']}/{oid}"
    query('INSERT INTO observations (id,user_id,media_key,media_type,media_size,status) VALUES (%s,%s,%s,%s,%s,%s)',(oid,session['uid'],key,mime,size,'uploading'))
    try:
        url=s3().generate_presigned_url('put_object',Params={'Bucket':os.environ['S3_BUCKET'],'Key':key,'ContentType':mime},ExpiresIn=300)
    except Exception:
        query('DELETE FROM observations WHERE id=%s AND user_id=%s',(oid,session['uid'])); return fail('Storage unavailable',503)
    return jsonify(id=oid,url=url,method='PUT',content_type=mime,expires_seconds=300)

@app.post('/api/observations/<uuid:oid>/complete')
@require('user')
def complete(oid):
    d=request.get_json(silent=True) or {}; species=str(d.get('species','')).strip()[:120]; notes=str(d.get('notes','')).strip()[:2000]
    row=query('SELECT media_key,media_size,media_type,status FROM observations WHERE id=%s AND user_id=%s',(str(oid),session['uid']),True)
    if not row or row['status']!='uploading': return fail('Upload not found',404)
    try: obj=s3().head_object(Bucket=os.environ['S3_BUCKET'],Key=row['media_key'])
    except Exception: return fail('Upload not found in private storage',400)
    if obj['ContentLength']!=row['media_size'] or obj.get('ContentType')!=row['media_type']: return fail('Uploaded file metadata mismatch',400)
    query("UPDATE observations SET species=%s,notes=%s,status='pending' WHERE id=%s AND user_id=%s",(species,notes,str(oid),session['uid']))
    return jsonify(ok=True,status='pending')

@app.get('/api/observations/<uuid:oid>/media')
@require()
def media(oid):
    row=query('SELECT media_key,user_id,status FROM observations WHERE id=%s',(str(oid),),True)
    if not row or row['status']=='uploading' or (session['role']!='researcher' and str(row['user_id'])!=session['uid']): return fail('Not found',404)
    try: url=s3().generate_presigned_url('get_object',Params={'Bucket':os.environ['S3_BUCKET'],'Key':row['media_key']},ExpiresIn=60)
    except Exception: return fail('Storage unavailable',503)
    return jsonify(url=url,expires_seconds=60)

@app.post('/api/observations/<uuid:oid>/review')
@require('researcher')
def review(oid):
    d=request.get_json(silent=True) or {}; status=d.get('status'); species=str(d.get('species','')).strip()[:120]
    if status not in ('verified','rejected'): return fail('Invalid review decision')
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE observations SET status=%s,species=CASE WHEN %s<>'' THEN %s ELSE species END,reviewer_id=%s,reviewed_at=now() WHERE id=%s AND status='pending' RETURNING id",(status,species,species,session['uid'],str(oid)))
            if not cur.fetchone(): return fail('Pending observation not found',404)
            cur.execute('INSERT INTO audit_log (actor_id,action,target_id) VALUES (%s,%s,%s)',(session['uid'],'observation.'+status,str(oid)))
    return jsonify(ok=True)

@app.get('/api/health')
def health(): return jsonify(status='ok')

if __name__=='__main__': app.run(debug=os.getenv('APP_ENV')!='production')
