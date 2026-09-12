const crypto = require('crypto');
const admin = require('firebase-admin');
const { google } = require('googleapis');

function env(name, required = true) {
  const value = process.env[name];
  if (required && !value) throw new Error(`Missing server environment variable: ${name}`);
  return value || '';
}

function getAdmin() {
  if (admin.apps.length) return admin.app();
  const raw = env('FIREBASE_SERVICE_ACCOUNT_JSON');
  let credential;
  try { credential = admin.credential.cert(JSON.parse(raw)); }
  catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.'); }
  return admin.initializeApp({ credential });
}

function db() { return getAdmin().firestore(); }

async function authenticate(req) {
  getAdmin();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : String(req.body?.idToken || req.query?.idToken || '');
  if (!token) throw apiError('You must be signed in.', 'AUTH_REQUIRED', 401);
  try {
    const decoded = await admin.auth().verifyIdToken(token, true);
    return decoded;
  } catch {
    throw apiError('Your session has expired. Please sign in again.', 'AUTH_INVALID', 401);
  }
}

function apiError(message, code = 'SERVER_ERROR', status = 400) {
  const error = new Error(message); error.code = code; error.status = status; return error;
}

function clean(value, max = 500) { return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max); }
function id() { return crypto.randomUUID(); }
function classCode() { return crypto.randomBytes(4).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); }
function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TIME_ZONE || 'Asia/Karachi' }).format(new Date()); }
function emailOf(actor) { return String(actor.email || '').trim().toLowerCase(); }

function googleClient() {
  return new google.auth.OAuth2(env('GOOGLE_CLIENT_ID'), env('GOOGLE_CLIENT_SECRET'), env('GOOGLE_REDIRECT_URI'));
}

function encrypt(text) {
  const keyRaw = env('GOOGLE_TOKEN_ENCRYPTION_KEY');
  const key = crypto.createHash('sha256').update(keyRaw).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}
function decrypt(payload) {
  const [iv, tag, data] = String(payload).split('.');
  const key = crypto.createHash('sha256').update(env('GOOGLE_TOKEN_ENCRYPTION_KEY')).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

async function userDoc(uid) {
  const ref = db().collection('users').doc(uid); const snap = await ref.get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function ensureUser(actor) {
  const ref = db().collection('users').doc(actor.uid); const snap = await ref.get();
  if (snap.exists) return { id: snap.id, ...snap.data() };
  const data = { email: emailOf(actor), name: clean(actor.name || actor.email?.split('@')[0] || ''), photoURL: actor.picture || '', role: 'pending', roleStatus: 'incomplete', profileCompleted: false, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  await ref.set(data); return { id: actor.uid, ...data };
}

async function resolveUser(actor) {
  const user = await ensureUser(actor);
  if (user.role && user.role !== 'pending') return user;
  // Backward compatibility: legacy staff can still be recognized from migration docs.
  const legacy = await db().collection('legacyUsers').doc(actor.uid).get();
  if (legacy.exists) return { ...user, ...legacy.data() };
  return user;
}

function roleLabel(role) { return ({ cr: 'Class Representative', teacher: 'Teacher', student: 'Student', pending: 'Complete profile' })[role] || role; }

async function membership(classId, uid) {
  const snap = await db().collection('classes').doc(classId).collection('members').doc(uid).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function assertClassAccess(actor, classId, write = false) {
  const user = await resolveUser(actor);
  const cls = await db().collection('classes').doc(String(classId)).get();
  if (!cls.exists) throw apiError('Class not found.', 'NOT_FOUND', 404);
  const data = cls.data();
  if (user.role === 'cr' && data.crUid === actor.uid) return { user, cls: data };
  const member = await membership(String(classId), actor.uid);
  if (member && (member.status === 'approved' || member.status === 'active')) {
    if (user.role === 'teacher' && write && member.role !== 'teacher') throw apiError('You do not have write access to this class.', 'FORBIDDEN', 403);
    return { user, cls: data, member };
  }
  throw apiError('You do not have access to this class.', 'FORBIDDEN', 403);
}

async function teacherCanSubject(actor, subjectId, write = false) {
  const subjectSnap = await db().collection('subjects').doc(subjectId).get();
  if (!subjectSnap.exists) throw apiError('Subject not found.', 'NOT_FOUND', 404);
  const subject = { id: subjectSnap.id, ...subjectSnap.data() };
  const { user, cls } = await assertClassAccess(actor, subject.classId, write);
  if (user.role === 'cr') return { subject, user, cls };
  if (user.role === 'teacher' && subject.teacherUid !== actor.uid) throw apiError('You are not assigned to this subject.', 'FORBIDDEN', 403);
  return { subject, user, cls };
}

async function getGoogleSheetsClient(uid) {
  const snap = await db().collection('googleConnections').doc(uid).get();
  if (!snap.exists) throw apiError('Connect your Google account before using a class spreadsheet.', 'GOOGLE_NOT_CONNECTED', 409);
  const token = decrypt(snap.data().refreshTokenEncrypted);
  const client = googleClient(); client.setCredentials({ refresh_token: token });
  return google.sheets({ version: 'v4', auth: client });
}

async function getDriveClient(uid) {
  const snap = await db().collection('googleConnections').doc(uid).get();
  if (!snap.exists) throw apiError('Connect your Google account first.', 'GOOGLE_NOT_CONNECTED', 409);
  const client = googleClient(); client.setCredentials({ refresh_token: decrypt(snap.data().refreshTokenEncrypted) });
  return google.drive({ version: 'v3', auth: client });
}

async function sheetMeta(uid, spreadsheetId) {
  const drive = await getDriveClient(uid);
  try {
    const r = await drive.files.get({ fileId: spreadsheetId, fields: 'id,name,mimeType,trashed,owners(emailAddress),capabilities(canEdit)' });
    if (r.data.mimeType !== 'application/vnd.google-apps.spreadsheet' || r.data.trashed || !r.data.capabilities?.canEdit) throw apiError('The selected file is not an editable Google Sheet.', 'SHEET_INVALID', 422);
    return r.data;
  } catch (e) { if (e.code) throw e; throw apiError('The Google Sheet could not be accessed. Make sure you authorized the app and can edit the sheet.', 'SHEET_ACCESS_DENIED', 403); }
}

async function spreadsheetInfo(uid, spreadsheetId) {
  const sheets = await getGoogleSheetsClient(uid);
  try { return (await sheets.spreadsheets.get({ spreadsheetId, fields: 'spreadsheetId,properties(title),sheets(properties(sheetId,title,index))' })).data; }
  catch { throw apiError('The connected Google Sheet is unavailable or access was revoked.', 'SHEET_ACCESS_DENIED', 403); }
}

async function ensureTab(sheets, spreadsheetId, title) {
  const info = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(sheetId,title))' });
  const existing = info.data.sheets?.find(s => s.properties.title === title);
  if (existing) return existing.properties.sheetId;
  const res = await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title } } }] } });
  return res.data.replies[0].addSheet.properties.sheetId;
}

async function writeClassBlueprint(uid, cls) {
  const sheets = await getGoogleSheetsClient(uid); const sid = cls.spreadsheetId;
  const info = await spreadsheetInfo(uid, sid);
  const master = await ensureTab(sheets, sid, 'Class Info');
  const students = await ensureTab(sheets, sid, 'Students');
  const subjects = await ensureTab(sheets, sid, 'Subjects');
  await sheets.spreadsheets.values.update({ spreadsheetId: sid, range: `'Class Info'!A1:B8`, valueInputOption: 'USER_ENTERED', requestBody: { values: [['Attendance Register',''],['Class',cls.name],['University',cls.university],['Semester',cls.semester],['Department',cls.department],['Batch',cls.batch],['Section',cls.section],['Class Code',cls.classCode]] } });
  await sheets.spreadsheets.values.update({ spreadsheetId: sid, range: `'Students'!A1:E1`, valueInputOption: 'RAW', requestBody: { values: [['Student ID','Name','Father Name','Email','Status']] } });
  await sheets.spreadsheets.values.update({ spreadsheetId: sid, range: `'Subjects'!A1:E1`, valueInputOption: 'RAW', requestBody: { values: [['Subject ID','Subject Name','Code','Teacher UID','Teacher Name']] } });
  return { spreadsheetTitle: info.properties.title, sheetCount: info.sheets?.length || 0, master, students, subjects };
}

async function syncSubjectTab(uid, cls, subject) {
  const sheets = await getGoogleSheetsClient(uid); const title = subject.name.slice(0, 90) || subject.id;
  const sheetId = await ensureTab(sheets, cls.spreadsheetId, title);
  subject.sheetTitle = title; subject.sheetId = sheetId;
  await sheets.spreadsheets.values.update({ spreadsheetId: cls.spreadsheetId, range: `'${title.replace(/'/g,"''")}'!A1:B1`, valueInputOption: 'RAW', requestBody: { values: [['Student ID','Name']] } });
  return subject;
}

async function rebuildStudentsTab(uid, cls) {
  const sheets = await getGoogleSheetsClient(uid); const snap = await db().collection('classes').doc(cls.id).collection('members').where('role','==','student').where('status','==','approved').get();
  const rows = [['Student ID','Name','Father Name','Email','Status']]; snap.forEach(d => { const s=d.data(); rows.push([s.seatNumber || s.studentId || '', s.name || '', s.fatherName || '', s.email || '', 'Active']); });
  await sheets.spreadsheets.values.clear({ spreadsheetId: cls.spreadsheetId, range: 'Students!A2:Z' });
  await sheets.spreadsheets.values.update({ spreadsheetId: cls.spreadsheetId, range: 'Students!A1', valueInputOption: 'RAW', requestBody: { values: rows } });
}



async function syncStudentAcrossSubjectTabs(crUid, cls, student) {
  const sheets = await getGoogleSheetsClient(crUid);
  const subjectsSnap = await db().collection('subjects').where('classId','==',cls.id).get();
  for (const d of subjectsSnap.docs) {
    const subject = {id:d.id,...d.data()};
    const title = subject.sheetTitle || subject.name.slice(0,90);
    await ensureTab(sheets, cls.spreadsheetId, title);
    const safe = title.replace(/'/g,"''");
    const existing = await sheets.spreadsheets.values.get({spreadsheetId:cls.spreadsheetId,range:`'${safe}'!A:ZZ`});
    const values = existing.data.values || [['Student ID','Name']];
    const idx = values.findIndex((r,i)=>i>0&&String(r[0]||'').trim()===String(student.seatNumber||''));
    if(idx===-1) values.push([student.seatNumber||'',student.name||'']);
    else { values[idx][0]=student.seatNumber||values[idx][0]||''; values[idx][1]=student.name||values[idx][1]||''; }
    await sheets.spreadsheets.values.clear({spreadsheetId:cls.spreadsheetId,range:`'${safe}'!A:ZZ`});
    await sheets.spreadsheets.values.update({spreadsheetId:cls.spreadsheetId,range:`'${safe}'!A1`,valueInputOption:'RAW',requestBody:{values}});
  }
}
async function writeAttendanceToSheet(crUid, cls, subject, date, records) {
  const sheets = await getGoogleSheetsClient(crUid);
  const title = subject.sheetTitle || subject.name.slice(0,90);
  await ensureTab(sheets, cls.spreadsheetId, title);
  const safeTitle = title.replace(/'/g,"''");
  const existing = await sheets.spreadsheets.values.get({spreadsheetId:cls.spreadsheetId, range:`'${safeTitle}'!A:ZZ`});
  let values = existing.data.values || [['Student ID','Name']];
  if (!values.length) values=[['Student ID','Name']];
  const totalIndex = values[0].findIndex(v => String(v || '').toLowerCase().startsWith('total'));
  if(totalIndex !== -1){ values = values.map(row => row.filter((_,i)=>i!==totalIndex)); }
  if (!values[0].length || values[0][0] !== 'Student ID') values[0]=['Student ID','Name',...values[0].slice(2)];
  let dateIndex=values[0].findIndex(v=>String(v)===date);
  if(dateIndex===-1){dateIndex=values[0].length;values[0][dateIndex]=date;}
  for(const row of values) while(row.length < values[0].length) row.push('');
  for(const rec of records){
    const seat=String(rec.studentId||'').trim(); if(!seat) continue;
    const row=values.findIndex((r,i)=>i>0&&String(r[0]||'').trim()===seat);
    if(row===-1) continue;
    values[row][dateIndex]=Number(rec.status);
  }
  for(let i=1;i<values.length;i++){
    const count=values[i].slice(2,dateIndex+1).filter(v=>v===1||v==='1').length;
    values[i][dateIndex+1]=count;
  }
  values[0][dateIndex+1]=`Total (of ${dateIndex-1})`;
  await sheets.spreadsheets.values.clear({spreadsheetId:cls.spreadsheetId,range:`'${safeTitle}'!A:ZZ`});
  await sheets.spreadsheets.values.update({spreadsheetId:cls.spreadsheetId,range:`'${safeTitle}'!A1`,valueInputOption:'RAW',requestBody:{values}});
  return {sheetTitle:title};
}

module.exports = { admin, db, env, authenticate, apiError, clean, id, classCode, today, emailOf, googleClient, encrypt, decrypt, userDoc, ensureUser, resolveUser, roleLabel, membership, assertClassAccess, teacherCanSubject, getGoogleSheetsClient, getDriveClient, sheetMeta, spreadsheetInfo, ensureTab, writeClassBlueprint, syncSubjectTab, rebuildStudentsTab };
