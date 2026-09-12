const { admin, db, authenticate, apiError, clean, id, classCode, today, emailOf, resolveUser, roleLabel, membership, assertClassAccess, teacherCanSubject, sheetMeta, spreadsheetInfo, writeClassBlueprint, syncSubjectTab, rebuildStudentsTab, getGoogleSheetsClient, writeAttendanceToSheet, syncStudentAcrossSubjectTabs } = require('./_lib/server');

const cors = { 'Access-Control-Allow-Origin': process.env.APP_ORIGIN || '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };

function send(res, status, body) { res.status(status).set(cors).json(body); }
async function withAuth(req, fn) {
  const actor = await authenticate(req); const user = await resolveUser(actor); return fn(actor, user);
}
function publicUser(actor, user) { return { uid: actor.uid, email: emailOf(actor), name: user.name || actor.name || '', photoURL: user.photoURL || actor.picture || '', role: user.role || 'pending', roleLabel: roleLabel(user.role || 'pending'), profileCompleted: !!user.profileCompleted, roleStatus: user.roleStatus || 'incomplete' }; }
function cleanClass(c, id) { return { ClassID:id, ClassName:c.name, AcademicYear:c.academicYear || '', University:c.university || '', Semester:c.semester || '', Department:c.department || '', Batch:c.batch || '', Section:c.section || '', ClassCode:c.classCode, SpreadsheetId:c.spreadsheetId, SpreadsheetName:c.spreadsheetName || '', CRUid:c.crUid, Status:c.status || 'active' }; }

async function listClasses(actor, user) {
  const snap = await db().collection('classes').where('status','==','active').get();
  const out=[];
  for (const d of snap.docs) {
    const c=d.data();
    if (user.role==='cr' && c.crUid !== actor.uid) continue;
    if (user.role==='student' || user.role==='teacher') {
      const m=await membership(d.id,actor.uid);
      if (!m || m.status!=='approved') continue;
    }
    out.push(cleanClass(c,d.id));
  }
  return out;
}
async function listSubjects(actor,user,params={}) {
  let q=db().collection('subjects');
  if(params.classId) q=q.where('classId','==',String(params.classId));
  const snap=await q.get(); const out=[];
  for(const d of snap.docs){
    const s=d.data();
    if(user.role==='student'){const m=await membership(s.classId,actor.uid); if(!m||m.status!=='approved')continue;}
    if(user.role==='teacher'&&s.teacherUid!==actor.uid)continue;
    if(user.role==='cr'){const cls=await db().collection('classes').doc(s.classId).get(); if(!cls.exists||cls.data().crUid!==actor.uid)continue;}
    out.push({SubjectID:d.id,SubjectName:s.name,Code:s.code||'',TeacherID:s.teacherUid||'',ClassID:s.classId});
  }
  return out;
}
async function listStudents(actor,user,params={}) { if(user.role==='student') throw apiError('Students cannot list other students.','FORBIDDEN',403); const classId=String(params.classId||''); if(!classId) return []; await assertClassAccess(actor,classId,false); const snap=await db().collection('classes').doc(classId).collection('members').where('role','==','student').where('status','==','approved').get(); return snap.docs.map(d=>{const s=d.data();return {StudentID:s.seatNumber||s.studentId,Name:s.name,Email:s.email,ClassID:classId,Status:'Active',FatherName:s.fatherName||''};}); }
async function listTeachers(actor,user){ if(user.role==='student')throw apiError('Students cannot list teachers.','FORBIDDEN',403); const snap=await db().collection('users').where('role','==','teacher').get(); return snap.docs.map(d=>({TeacherID:d.id,Name:d.data().name||'',Role:'Teacher'})); }
async function listAttendance(actor,user,params={}) { const classId=String(params.classId||user.classId||''); if(!classId) return []; const subjects=await listSubjects(actor,user,{classId}); let rows=[]; for(const s of subjects){const snap=await db().collection('attendance').doc(`${classId}_${s.SubjectID}`).collection('sessions').get(); snap.forEach(d=>{const v=d.data(); if(params.date&&d.id!==params.date)return; if(user.role==='student'&&v.marks?.[actor.uid]!==undefined)rows.push({AttendanceID:`${s.SubjectID}_${actor.uid}_${d.id}`,Date:d.id,SubjectID:s.SubjectID,StudentID:actor.uid,Status:Number(v.marks[actor.uid])}); else if(user.role!=='student') for(const [uid,status] of Object.entries(v.marks||{})) rows.push({AttendanceID:`${s.SubjectID}_${uid}_${d.id}`,Date:d.id,SubjectID:s.SubjectID,StudentID:uid,Status:Number(status)});}); } return rows; }
async function getSubjectSheet(actor,user,params){const subjectId=String(params.subjectId||''); const {subject,cls}=await teacherCanSubject(actor,subjectId,false); const studentsSnap=await db().collection('classes').doc(subject.classId).collection('members').where('role','==','student').where('status','==','approved').get(); const sessions=await db().collection('attendance').doc(`${subject.classId}_${subjectId}`).collection('sessions').get(); const dates=sessions.docs.map(d=>d.id).sort(); const rows=[]; studentsSnap.forEach(d=>{const s=d.data(); if(user.role==='student'&&d.id!==actor.uid)return; const marks={}; dates.forEach(dt=>{const m=sessions.docs.find(x=>x.id===dt)?.data()?.marks||{}; marks[dt]=m[d.id]===undefined?null:Number(m[d.id]);}); rows.push({sheetRowNumber:rows.length+2,studentId:s.seatNumber||d.id,name:s.name||'',marks,total:Object.values(marks).filter(v=>v===1).length});}); return {subjectId,subjectName:subject.name,classId:subject.classId,headers:['Student ID','Name',...dates],dates:dates.map(date=>({date})),totalHeader:`Total (of ${dates.length})`,rows,today:today()}; }

async function action(req,actor,user,action,body,query){
 switch(action){
 case 'me': return publicUser(actor,user);
 case 'bootstrap': { const p={me:publicUser(actor,user)}; if(user.role==='student'){const classes=await listClasses(actor,user);p.classes=classes;p.subjects=await listSubjects(actor,user,{classId:classes[0]?.ClassID});} else if(user.role==='pending'){p.classes=await listClasses(actor,user);p.enrollment=await latestRequest(actor.uid);} else {p.classes=await listClasses(actor,user);p.subjects=await listSubjects(actor,user,{});p.students=[];for(const c of p.classes){const ss=await listStudents(actor,user,{classId:c.ClassID});p.students.push(...ss);}p.teachers=await listTeachers(actor,user);p.enrollmentRequests=await getRequests(actor,user);} return p; }
 case 'classes': return listClasses(actor,user);
 case 'subjects': return listSubjects(actor,user,query);
 case 'students': return listStudents(actor,user,query);
 case 'teachers': return listTeachers(actor,user);
 case 'attendance': return listAttendance(actor,user,query);
 case 'subjectSheet': return getSubjectSheet(actor,user,query);
 case 'enrollment': {const r=await latestRequest(actor.uid);let status=r?.status||'Not started';if(user.role==='student'){const classes=await listClasses(actor,user);status=classes.length?'Approved':(r?.status||'Not started');return {status,request:r,classes};}return {status,request:r,classes:await listClasses(actor,user)};}
 case 'enrollmentRequests': return getRequests(actor,user);
 case 'saveProfile': return saveProfile(actor,user,body);
 case 'connectGoogleSheet': return connectSheet(actor,user,body);
 case 'googleConnection': return googleConnection(actor,user);
 case 'addClass': return addClass(actor,user,body);
 case 'addSubject': return addSubject(actor,user,body);
 case 'addStudent': return addStudent(actor,user,body);
 case 'submitEnrollment': return submitEnrollment(actor,user,body);
 case 'reviewEnrollment': return reviewEnrollment(actor,user,body);
 case 'saveAttendance': return saveAttendance(actor,user,body);
 case 'deleteAttendance': return deleteAttendance(actor,user,body);
 case 'deleteSubjectSheetRow': throw apiError('Direct sheet row editing is disabled in the production API. Use the class membership controls.','NOT_SUPPORTED',409);
 case 'deleteSubjectSheetColumn': throw apiError('Attendance history is immutable after submission.','FORBIDDEN',403);
 case 'renameSubjectSheetRow': throw apiError('Student identity is managed from the class roster.','NOT_SUPPORTED',409);
 case 'purgeMissingSubjects': return {purged:0};
 default: throw apiError(`Unknown action "${action}".`,'BAD_REQUEST',400);
 }
}

async function saveProfile(actor,user,b){
  const role=clean(b.role,20).toLowerCase();
  if(!['student','teacher','cr'].includes(role))throw apiError('Choose a valid role.','VALIDATION_ERROR',422);
  const name=clean(b.name,80); if(!name)throw apiError('Name is required.','VALIDATION_ERROR',422);
  let roleStatus='pending';
  if(role==='student') roleStatus='approved';
  if(role==='cr'){
    const allowed=(process.env.CR_INVITE_EMAILS||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
    if(allowed.includes(emailOf(actor)) && process.env.CR_INVITE_CODE && b.inviteCode===process.env.CR_INVITE_CODE) roleStatus='approved';
  }
  const data={name,photoURL:actor.picture||user.photoURL||'',profileCompleted:true,role,roleStatus,updatedAt:admin.firestore.FieldValue.serverTimestamp()};
  await db().collection('users').doc(actor.uid).set(data,{merge:true});
  if(role==='teacher'){
    const classCodeValue=clean(b.classCode,20).toUpperCase();
    if(!classCodeValue) throw apiError('Enter your class code to request teacher access.','VALIDATION_ERROR',422);
    const cq=await db().collection('classes').where('classCode','==',classCodeValue).limit(1).get();
    if(cq.empty) throw apiError('That class code does not exist.','NOT_FOUND',404);
    const classId=cq.docs[0].id;
    const existing=await db().collection('enrollmentRequests').where('uid','==',actor.uid).where('status','==','Pending').limit(1).get();
    if(existing.empty){const ref=db().collection('enrollmentRequests').doc();await ref.set({requestId:ref.id,uid:actor.uid,name,email:emailOf(actor),classId,type:'teacher',status:'Pending',createdAt:admin.firestore.FieldValue.serverTimestamp()});}
  }
  return {role,roleStatus};
}
async function googleConnection(actor,user){const snap=await db().collection('googleConnections').doc(actor.uid).get(); return {connected:snap.exists,spreadsheetId:user.spreadsheetId||'',spreadsheetName:user.spreadsheetName||''};}
async function connectSheet(actor,user,b){if(user.role!=='cr'||user.roleStatus!=='approved')throw apiError('Only an approved Class Representative can connect a class sheet.','FORBIDDEN',403); const url=clean(b.url,500); const m=url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/); if(!m)throw apiError('Paste a valid Google Sheets URL.','VALIDATION_ERROR',422); const sid=m[1]; const meta=await sheetMeta(actor.uid,sid); const existing=await db().collection('classes').where('spreadsheetId','==',sid).limit(1).get(); if(!existing.empty)throw apiError('This Google Sheet is already connected to another class.','CONFLICT',409); await db().collection('users').doc(actor.uid).set({spreadsheetId:sid,spreadsheetName:meta.name},{merge:true}); return {spreadsheetId:sid,spreadsheetName:meta.name}; }
async function addClass(actor,user,b){if(user.role!=='cr'||user.roleStatus!=='approved')throw apiError('Only an approved CR can create a class.','FORBIDDEN',403); const required=['className','university','semester','department','batch','section']; for(const k of required)if(!clean(b[k],120))throw apiError(`${k} is required.`,'VALIDATION_ERROR',422); if(!user.spreadsheetId)throw apiError('Connect your Google Sheet first.','GOOGLE_NOT_CONNECTED',409); let code; do{code=classCode();}while(!(await db().collection('classes').where('classCode','==',code).limit(1).get()).empty); const ref=db().collection('classes').doc(); const cls={name:clean(b.className,120),university:clean(b.university,120),semester:clean(b.semester,80),department:clean(b.department,120),batch:clean(b.batch,40),section:clean(b.section,20),academicYear:clean(b.academicYear||'',40),classCode:code,spreadsheetId:user.spreadsheetId,spreadsheetName:user.spreadsheetName||'',crUid:actor.uid,status:'active',createdAt:admin.firestore.FieldValue.serverTimestamp()}; await ref.set(cls); await writeClassBlueprint(actor.uid,{...cls,id:ref.id}); await db().collection('classes').doc(ref.id).collection('members').doc(actor.uid).set({role:'cr',status:'approved',name:user.name,email:emailOf(actor),createdAt:admin.firestore.FieldValue.serverTimestamp()}); return {...cleanClass(cls,ref.id),classId:ref.id,className:cls.name}; }
async function addSubject(actor,user,b){if(user.role!=='cr')throw apiError('Only the Class Representative can create or assign subjects.','FORBIDDEN',403); const classId=String(b.classId||''); await assertClassAccess(actor,classId,true); const clsSnap=await db().collection('classes').doc(classId).get(); const cls={id:classId,...clsSnap.data()}; const teacherUid=String(b.teacherId||actor.uid); const ref=db().collection('subjects').doc(); const subject={name:clean(b.subjectName,120),code:clean(b.subjectCode||'',40),teacherUid,classId,createdAt:admin.firestore.FieldValue.serverTimestamp()}; await ref.set(subject); await syncSubjectTab(cls.crUid,cls,{id:ref.id,...subject}); return {SubjectID:ref.id,SubjectName:subject.name,Code:subject.code,TeacherID:teacherUid,ClassID:classId,subjectId:ref.id,subjectName:subject.name,classId,teacherId:teacherUid}; }
async function addStudent(actor,user,b){if(user.role!=='cr')throw apiError('Only the Class Representative can add students manually.','FORBIDDEN',403); const classId=String(b.classId||''); await assertClassAccess(actor,classId,true); const seat=clean(b.seatNumber,40); const email=clean(b.email,200).toLowerCase(); if(!seat||!clean(b.name,80)||!email)throw apiError('Seat number, name, and email are required.','VALIDATION_ERROR',422); const q=await db().collection('classes').doc(classId).collection('members').where('seatNumber','==',seat).limit(1).get(); if(!q.empty)throw apiError('That seat number is already registered.','CONFLICT',409); const u=await db().collection('users').where('email','==',email).limit(1).get(); const uid=u.empty?`manual_${id()}`:u.docs[0].id; await db().collection('classes').doc(classId).collection('members').doc(uid).set({role:'student',status:'approved',seatNumber:seat,name:clean(b.name,80),fatherName:clean(b.fatherName||'',80),email}, {merge:true}); const clsData=(await db().collection('classes').doc(classId).get()).data();await rebuildStudentsTab(clsData.crUid,{id:classId,...clsData});await syncStudentAcrossSubjectTabs(clsData.crUid,{id:classId,...clsData},{seatNumber:seat,name:clean(b.name,80)}); return {studentId:seat,name:clean(b.name,80),email,classId}; }
async function submitEnrollment(actor,user,b){if(user.role!=='student'&&user.role!=='pending')throw apiError('This account cannot submit a student enrollment request.','FORBIDDEN',403); let classId=clean(b.classId,100),seat=clean(b.seatNumber,40),name=clean(b.name,80); if(!classId&&b.classCode){const cq=await db().collection('classes').where('classCode','==',clean(b.classCode,20).toUpperCase()).limit(1).get();if(!cq.empty)classId=cq.docs[0].id;} if(!classId||!seat||!name)throw apiError('Name, seat number, and class are required.','VALIDATION_ERROR',422); const c=await db().collection('classes').doc(classId).get();if(!c.exists)throw apiError('Class not found.','NOT_FOUND',404); const taken=await db().collection('classes').doc(classId).collection('members').where('seatNumber','==',seat).limit(1).get();if(!taken.empty)throw apiError('That seat number is already registered.','CONFLICT',409); const pending=await db().collection('enrollmentRequests').where('uid','==',actor.uid).where('status','==','Pending').limit(1).get();if(!pending.empty)throw apiError('You already have a pending enrollment request.','CONFLICT',409); const ref=db().collection('enrollmentRequests').doc();const r={requestId:ref.id,uid:actor.uid,name,seatNumber:seat,email:emailOf(actor),classId,status:'Pending',createdAt:admin.firestore.FieldValue.serverTimestamp()};await ref.set(r);await db().collection('users').doc(actor.uid).set({name,role:'student',roleStatus:'approved',profileCompleted:true},{merge:true});return {requestId:ref.id,classId,status:'Pending'};}
async function latestRequest(uid){const q=await db().collection('enrollmentRequests').where('uid','==',uid).orderBy('createdAt','desc').limit(1).get();return q.empty?null:{id:q.docs[0].id,...q.docs[0].data()};}
async function getRequests(actor,user){
  if(!['cr','teacher'].includes(user.role)||user.roleStatus!=='approved')throw apiError('Forbidden.','FORBIDDEN',403);
  const snap=await db().collection('enrollmentRequests').where('status','==','Pending').get(); const out=[];
  for(const d of snap.docs){const r=d.data();const c=await db().collection('classes').doc(r.classId).get();if(!c.exists)continue;
    if(r.type==='teacher'){if(c.data().crUid===actor.uid)out.push({...r,RequestID:d.id,ClassID:r.classId,Name:r.name,Email:r.email,SeatNumber:''});continue;}
    if(user.role==='cr'&&c.data().crUid===actor.uid)out.push({...r,RequestID:d.id,ClassID:r.classId,Name:r.name,Email:r.email,SeatNumber:r.seatNumber});
    if(user.role==='teacher'){const m=await membership(r.classId,actor.uid);if(m?.status==='approved')out.push({...r,RequestID:d.id,ClassID:r.classId,Name:r.name,Email:r.email,SeatNumber:r.seatNumber});}
  } return out;
}
async function reviewEnrollment(actor,user,b){
  if(!['cr','teacher'].includes(user.role))throw apiError('Forbidden.','FORBIDDEN',403);
  const ref=db().collection('enrollmentRequests').doc(String(b.requestId||'')); const snap=await ref.get(); if(!snap.exists)throw apiError('Request not found.','NOT_FOUND',404); const r=snap.data();
  await assertClassAccess(actor,r.classId,true);
  const status=String(b.status||'').toLowerCase()==='approved'?'Approved':'Rejected';
  await ref.set({status,reviewedAt:admin.firestore.FieldValue.serverTimestamp(),reviewedBy:actor.uid,decisionNote:clean(b.note||'',500)},{merge:true});
  if(status==='Approved'){
    if(r.type==='teacher'){await db().collection('classes').doc(r.classId).collection('members').doc(r.uid).set({role:'teacher',status:'approved',name:r.name,email:r.email,createdAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});await db().collection('users').doc(r.uid).set({name:r.name,role:'teacher',roleStatus:'approved',profileCompleted:true},{merge:true});}
    else {await db().collection('classes').doc(r.classId).collection('members').doc(r.uid).set({role:'student',status:'approved',seatNumber:r.seatNumber,name:r.name,email:r.email,createdAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});await db().collection('users').doc(r.uid).set({name:r.name,role:'student',roleStatus:'approved',profileCompleted:true},{merge:true});const cls=await db().collection('classes').doc(r.classId).get();await rebuildStudentsTab(cls.data().crUid,{id:r.classId,...cls.data()});await syncStudentAcrossSubjectTabs(cls.data().crUid,{id:r.classId,...cls.data()},{seatNumber:r.seatNumber,name:r.name});}
  } return {status};
}
async function saveAttendance(actor,user,b){const subjectId=clean(b.subjectId,100);const date=clean(b.date,20);const {subject}=await teacherCanSubject(actor,subjectId,true);if(date>today())throw apiError('You cannot mark attendance for a future date.','VALIDATION_ERROR',422);const ref=db().collection('attendance').doc(`${subject.classId}_${subjectId}`).collection('sessions').doc(date);const existing=await ref.get();if(existing.exists&&date!==today())throw apiError('This date has already been submitted and is locked.','FORBIDDEN',403);const records=Array.isArray(b.records)?b.records:[];const marks={...(existing.data()?.marks||{})};for(const r of records){const seat=clean(r.studentId||'',80);const q=await db().collection('classes').doc(subject.classId).collection('members').where('seatNumber','==',seat).where('status','==','approved').limit(1).get();if(q.empty)continue;const uid=q.docs[0].id;const status=Number(r.status);if(status!==0&&status!==1)throw apiError('Attendance status must be 0 or 1.','VALIDATION_ERROR',422);marks[uid]=status;}await ref.set({date,subjectId,classId:subject.classId,marks,updatedBy:actor.uid,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});const clsSnap=await db().collection('classes').doc(subject.classId).get();const cls={id:subject.classId,...clsSnap.data()};await writeAttendanceToSheet(cls.crUid,cls,subject,date,records);return {date,subjectId,results:records.map(r=>({studentId:r.studentId,action:'saved'}))};}
async function deleteAttendance(actor,user,b){const parts=String(b.attendanceId||'').split('_');if(parts.length<3)throw apiError('Invalid record reference.','BAD_REQUEST',400);const date=parts.pop(),uid=parts.pop(),subjectId=parts.join('_');if(date!==today())throw apiError('Previous-day attendance cannot be changed.','FORBIDDEN',403);const {subject}=await teacherCanSubject(actor,subjectId,true);const ref=db().collection('attendance').doc(`${subject.classId}_${subjectId}`).collection('sessions').doc(date);const snap=await ref.get();if(!snap.exists)throw apiError('Record not found.','NOT_FOUND',404);const marks={...(snap.data().marks||{})};delete marks[uid];await ref.update({marks,updatedAt:admin.firestore.FieldValue.serverTimestamp()});const clsSnap=await db().collection('classes').doc(subject.classId).get();const cls={id:subject.classId,...clsSnap.data()};const remaining=[];for(const [uid,status] of Object.entries(marks)){const m=await membership(subject.classId,uid);if(m?.seatNumber)remaining.push({studentId:m.seatNumber,status});}await writeAttendanceToSheet(cls.crUid,cls,subject,date,remaining);return {deleted:b.attendanceId};}

module.exports=async(req,res)=>{if(req.method==='OPTIONS')return send(res,204,{});try{const actor=await authenticate(req);const user=await resolveUser(actor);const body=req.body||{};const action=body.action||req.query.action;const data=await actionHandler(req,actor,user,action,body,req.query||{});return send(res,200,{success:true,data});}catch(e){console.error(e);return send(res,e.status||500,{success:false,error:e.message||'Server error.',code:e.code||'SERVER_ERROR'});}};
async function actionHandler(req,actor,user,action,body,query){return action(req,actor,user,action,body,query);}
