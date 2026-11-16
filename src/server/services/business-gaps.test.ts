import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { PublicUser } from "../controllers/session";

process.env.DATABASE_URL = "postgres://mock:mock@localhost/mock";
process.env.PGLITE_DATA_DIR = "memory";
register(pathToFileURL("./scripts/tests/agent/ttf-loader.mjs"));
const { setOverridePglite, withTx } = await import("../controllers/tx");
const { bookingsCancel, bookingsCancelQuote } = await import("../controllers/handlers/bookings");
const { paymentsRefund, paymentsApproveRefund, paymentsPayOutRefund, paymentsPending, shiftCurrent } = await import("../controllers/handlers/desk");
const { meTraining } = await import("../controllers/handlers/training");
const { classesPatch } = await import("../controllers/handlers/classes");

let db: PGlite;
let member: PublicUser, desk: PublicUser, payer: PublicUser, manager: PublicUser, coach: PublicUser;
let court: string;
let seq = 0;
const request = (body: object) => new Request("http://localhost/v1/test", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const row = async (id: string) => (await db.query<{ status: string; method: string; amount_vnd: number; shift_id: string | null }>(
  "select status::text, method::text, amount_vnd, shift_id from payments where id=$1", [id],
)).rows[0];

before(async () => {
  db = new PGlite();
  await db.waitReady;
  for (const f of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(`migrations/${f}`, "utf8"));
  }
  setOverridePglite(db);
  const users: PublicUser[] = [];
  for (const role of ["member", "receptionist", "receptionist", "manager", "coach"]) {
    const id = randomUUID();
    await db.query(`insert into users (id, phone, full_name, name_normalized, role, password_hash)
      values ($1,$2,'Gap test','gap test',$3,'hash')`, [id, `09777777${users.length.toString().padStart(2, "0")}`, role]);
    users.push({ id, role, full_name: "Gap test" } as PublicUser);
  }
  [member, desk, payer, manager, coach] = users;
  court = (await db.query<{ id: string }>("insert into courts (court_code, sport, status) values ('GAP-TEST','badminton','ready') returning id")).rows[0].id;
  await db.exec("update center_settings set refund_manager_vnd = 1000000; update feature_flags set enabled=true where key='F4'");
});
after(async () => { setOverridePglite(null); await db?.close(); });

async function booking(amount = 100000, owner = member) {
  const id = randomUUID();
  const day = ++seq;
  // Relative to the database clock, always in the future regardless of the time of day.
  const occ = (await db.query<{ id: string }>(`insert into occupancies (court_id,start_at,end_at,kind,ref_id)
    values ($1,now()+$3*interval '1 day',now()+$3*interval '1 day'+interval '1 hour','booking',$2) returning id`, [court,id,day])).rows[0].id;
  await db.query(`insert into court_bookings (id,code,court_id,user_id,start_at,end_at,status,channel,price_vnd,paid_vnd,occupancy_id)
    select $1,$2,$3,$4,start_at,end_at,'confirmed','app',$5,$5,id from occupancies where id=$6`, [id,`BK-GAP-${day}`,court,owner.id,amount,occ]);
  const payment = (await db.query<{ id: string }>(`insert into payments (code,user_id,method,amount_vnd,vat_rate,status,ref_type,ref_id)
    values ($1,$2,'card',$3,0,'posted','booking',$4) returning id`, [`PAY-GAP-${day}`,owner.id,amount,id])).rows[0].id;
  return { id, payment };
}
async function openShift(user: PublicUser) {
  await db.query("update cashier_shifts set closed_at=now() where receptionist_id=$1 and closed_at is null", [user.id]);
  return (await db.query<{ id: string }>("insert into cashier_shifts (receptionist_id) values ($1) returning id", [user.id])).rows[0].id;
}

describe("G0: cash refunds are owed until paid at the desk", () => {
  it("member quotes and cancellation refund nothing, even with a forged waiver", async () => {
    const b = await booking();
    const quote = await withTx((sql) => bookingsCancelQuote(sql,b.id,new Request("http://localhost/cancel?waive=1"),member));
    assert.equal(quote.body.refund_vnd,0);
    assert.equal(quote.body.refund_pct,0);
    const cancelled = await withTx((sql) => bookingsCancel(sql,b.id,member,request({ waive:true })));
    assert.equal(cancelled.body.refund,null);
    assert.equal((await db.query("select id from payments where ref_id=$1 and amount_vnd<0",[b.id])).rows.length,0);
  });

  it("centre cancellation requires a reason and creates a full pending cash refund below the threshold", async () => {
    const b = await booking();
    await assert.rejects(() => withTx((sql) => bookingsCancel(sql,b.id,desk,request({waive:true,reason:" "}))));
    const cancelled = await withTx((sql) => bookingsCancel(sql,b.id,desk,request({waive:true,reason:"Court closed"})));
    assert.ok(cancelled.body.refund && "id" in cancelled.body.refund);
    const id = cancelled.body.refund.id;
    assert.deepEqual(await row(id), {status:"refund_pending",method:"cash",amount_vnd:-100000,shift_id:null});
    await assert.rejects(() => withTx((sql) => paymentsPayOutRefund(sql,id,payer)), (e: any) => e.extra?.br === "BR-44");
    const shift = await openShift(payer);
    await withTx((sql) => paymentsPayOutRefund(sql,id,payer));
    assert.equal((await row(id)).shift_id,shift);
    const current = await withTx((sql) => shiftCurrent(sql,payer,new Request("http://localhost/current")));
    assert.equal(current.body.totals?.cash,-100000);
    await assert.rejects(() => withTx((sql) => paymentsPayOutRefund(sql,id,payer)));
  });

  it("large automatic refunds require manager approval, which itself moves no cash", async () => {
    const b = await booking(1200000);
    const cancelled = await withTx((sql) => bookingsCancel(sql,b.id,manager,request({waive:true,reason:"Court closed"})));
    assert.ok(cancelled.body.refund && "id" in cancelled.body.refund);
    const id = cancelled.body.refund.id;
    await assert.rejects(() => withTx((sql) => paymentsPayOutRefund(sql,id,payer)));
    await withTx((sql) => paymentsApproveRefund(sql,id,request({}),manager));
    assert.equal((await row(id)).status,"refund_pending");
    assert.equal((await row(id)).shift_id,null);
    await withTx((sql) => paymentsPayOutRefund(sql,id,payer));
    assert.equal((await row(id)).status,"posted");
  });

  it("manual refunds require a reason, stay pending, and debit the payer's new shift rather than the raiser's", async () => {
    const b = await booking();
    const raisedShift = await openShift(desk);
    await assert.rejects(() => withTx((sql) => paymentsRefund(sql,b.payment,request({amount_vnd:40000}),desk)));
    const refund = await withTx((sql) => paymentsRefund(sql,b.payment,request({amount_vnd:40000,reason:"Staff decision"}),desk));
    const id = (refund.body.payment as {id:string}).id;
    assert.equal((await row(id)).status,"refund_pending");
    const shift = await openShift(payer);
    await withTx((sql) => paymentsPayOutRefund(sql,id,payer));
    assert.equal((await row(id)).shift_id,shift);
    assert.notEqual(shift,raisedShift);
    const queue = await withTx((sql) => paymentsPending(sql,new Request("http://localhost/pending"),desk));
    assert.ok("refunds" in queue.body);
  });

  it("class cancellation stays pending and a manager without a till cannot pay it out", async () => {
    const cl = await makeClass();
    const seat = (await db.query<{id:string}>("insert into enrollments (class_id,user_id,status,price_vnd) values ($1,$2,'confirmed',200000) returning id",[cl,member.id])).rows[0].id;
    await db.query(`insert into payments (code,user_id,method,amount_vnd,vat_rate,status,ref_type,ref_id)
      values ('PAY-GAP-CLASS',$1,'transfer',200000,0,'posted','enrollment',$2)`,[member.id,seat]);
    await withTx((sql) => classesPatch(sql,cl,request({status:"cancelled",reason:"Centre closed"}),manager));
    const id = (await db.query<{id:string}>("select id from payments where ref_id=$1 and amount_vnd<0",[seat])).rows[0].id;
    assert.deepEqual(await row(id),{status:"refund_pending",method:"cash",amount_vnd:-200000,shift_id:null});
    await assert.rejects(() => withTx((sql) => paymentsPayOutRefund(sql,id,manager)),(e:any)=>e.extra?.br === "BR-44");
  });
});

async function makeClass() {
  return (await db.query<{id:string}>(`insert into classes (sport,level,coach_id,court_id,capacity,rrule,start_on,end_on,status)
    values ('badminton','beginner',$1,$2,10,'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10',current_date-30,current_date+30,'open') returning id`,[coach.id,court])).rows[0].id;
}
it("G7 Progress counts present and late attendance beyond the results page, excluding other users and cancelled sessions", async () => {
  const cl = await makeClass();
  for (let n=0;n<14;n++) {
    const session = (await db.query<{id:string}>(`insert into sessions (class_id,court_id,start_at,end_at,status)
      values ($1,$2,now()-($3+1)*interval '1 day',now()-($3+1)*interval '1 day'+interval '1 hour',$4) returning id`,[cl,court,n,n===13?'cancelled':'done'])).rows[0].id;
    await db.query("insert into attendance (kind,user_id,session_id,result) values ('session',$1,$2,$3)", [member.id,session,n===12?'absent':n%2?'late':'present']);
    await db.query("insert into attendance (kind,user_id,session_id,result) values ('session',$1,$2,'present')",[coach.id,session]);
  }
  const progress = await withTx((sql) => meTraining(sql,member));
  assert.equal(progress.body.results.length,0);
  assert.equal(progress.body.completed_sessions,12);
});

const { loyaltyRedeem } = await import("../controllers/handlers/extras");
const { loyaltyBalance, reconcileLoyaltyRefund } = await import("./loyalty");
const { quotePromo, redeemPromo } = await import("./promos");
async function loyaltyMember() {
  const id = randomUUID();
  await db.query(`insert into users (id,phone,full_name,name_normalized,role,password_hash)
    values ($1,$2,'Loyalty test','loyalty test','member','hash')`, [id, '0966'+String(++seq).padStart(6,'0')]);
  return { id, role: 'member', full_name: 'Loyalty test' } as PublicUser;
}
const redeem = (u: PublicUser, points: number) => withTx(sql => loyaltyRedeem(sql,request({points}),u));
const balance = (u: PublicUser, clamp = true) => withTx(sql => loyaltyBalance(sql,u.id,clamp));
const promoId = async (code: string) => (await db.query<{id:string}>("select id from promotions where code=$1",[code])).rows[0].id;
const quote = (u: PublicUser | null, code: string) => withTx(sql => quotePromo(sql,{code,userId:u?.id ?? null,scope:'court',orderVnd:1000000}));

describe("G1: loyalty rewards keep their owner and cannot outlive refunded earnings", () => {
  it("locks the member before reading earnings and rejects a competing redemption", async () => {
    const u = await loyaltyMember();
    const earn = (await balance(u)).earn_vnd;
    await booking(50*earn,u);
    const queries: string[] = [];
    const first = withTx(async sql => {
      const original = sql.query.bind(sql);
      sql.query = ((text: string, params?: unknown[]) => { queries.push(text); return original(text,params); }) as typeof sql.query;
      return loyaltyRedeem(sql,request({points:50}),u);
    });
    const outcomes = await Promise.allSettled([first,redeem(u,50)]);
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(outcomes.filter(r=>r.status==='rejected').length,1);
    const lock = queries.findIndex(q=>q.includes('from users') && q.includes('for update'));
    const earnings = queries.findIndex(q=>q.includes('sum(amount_vnd)'));
    assert.ok(lock>=0 && earnings>lock);
    assert.equal((await balance(u)).points,0);
  });

  it("allows only the owner at quote and payment, then voids the newest unused code once on a desk refund", async () => {
    const u = await loyaltyMember(), stranger = await loyaltyMember();
    const earn = (await balance(u)).earn_vnd;
    const b = await booking(150*earn,u);
    const old = (await redeem(u,50)).body.code;
    const newest = (await redeem(u,100)).body.code;
    await db.query("update loyalty_adjustments set created_at=now()-interval '1 day' where promo_id=$1",[await promoId(old)]);
    assert.ok((await quote(u,newest)).discount_vnd>0);
    await assert.rejects(()=>quote(stranger,newest),(e:any)=>e.extra?.br==='BR-40');
    await assert.rejects(()=>quote(null,newest),(e:any)=>e.extra?.br==='BR-40');
    const id = await promoId(newest);
    await assert.rejects(()=>withTx(sql=>redeemPromo(sql,{promoId:id,userId:stranger.id,paymentId:b.payment,discountVnd:100})),(e:any)=>e.extra?.br==='BR-40');
    await withTx(sql=>paymentsRefund(sql,b.payment,request({amount_vnd:50*earn,reason:'Centre adjustment'}),manager));
    await assert.rejects(()=>quote(u,newest));
    assert.ok((await quote(u,old)).discount_vnd>0);
    await assert.rejects(()=>withTx(sql=>redeemPromo(sql,{promoId:id,userId:u.id,paymentId:b.payment,discountVnd:100})),(e:any)=>e.extra?.br==='BR-40');
    await withTx(sql=>reconcileLoyaltyRefund(sql,u.id));
    const corrections = (await db.query<{points:number;note:string}>("select points,note from loyalty_adjustments where user_id=$1 and reason='correction'",[u.id])).rows;
    assert.deepEqual(corrections,[{points:100,note:newest}]);
    assert.equal((await balance(u)).points,50);
  });

  it("centre cancellation preserves used codes and debt, which future earnings repay before redemption", async () => {
    const u = await loyaltyMember();
    const earn = (await balance(u)).earn_vnd;
    const b = await booking(100*earn,u);
    const code = (await redeem(u,100)).body.code;
    const id = await promoId(code);
    await withTx(sql=>redeemPromo(sql,{promoId:id,userId:u.id,paymentId:b.payment,discountVnd:100}));
    await withTx(sql=>bookingsCancel(sql,b.id,manager,request({waive:true,reason:'Centre closed'})));
    const refundId = (await db.query<{id:string}>("select id from payments where ref_id=$1 and amount_vnd<0",[b.id])).rows[0].id;
    await withTx(sql=>paymentsApproveRefund(sql,refundId,request({}),manager));
    await openShift(payer);
    await withTx(sql=>paymentsPayOutRefund(sql,refundId,payer));
    assert.equal((await db.query<{status:string}>("select status from promotion_redemptions where promo_id=$1",[id])).rows[0].status,'applied');
    assert.equal((await balance(u,false)).points,-100);
    assert.equal((await balance(u)).points,0);
    assert.equal((await db.query("select id from loyalty_adjustments where user_id=$1 and reason='correction'",[u.id])).rows.length,0);
    await booking(50*earn,u);
    assert.equal((await balance(u,false)).points,-50);
    await assert.rejects(()=>redeem(u,50));
    await booking(100*earn,u);
    assert.equal((await balance(u)).points,50);
    assert.equal((await redeem(u,50)).body.points_left,0);
  });

  it("class refunds reconcile existing debt without adding tuition to loyalty earnings", async () => {
    const u = await loyaltyMember();
    const earn = (await balance(u)).earn_vnd;
    await booking(50*earn,u);
    const code = (await redeem(u,50)).body.code;
    await db.query("insert into loyalty_adjustments (user_id,points,reason,note) values ($1,-50,'correction','Test debit')",[u.id]);
    const cl = await makeClass();
    const seat = (await db.query<{id:string}>("insert into enrollments (class_id,user_id,status,price_vnd) values ($1,$2,'confirmed',200000) returning id",[cl,u.id])).rows[0].id;
    await db.query(`insert into payments (code,user_id,method,amount_vnd,vat_rate,status,ref_type,ref_id)
      values ($1,$2,'card',200000,0,'posted','enrollment',$3)`,['PAY-G1-'+(++seq),u.id,seat]);
    await withTx(sql=>classesPatch(sql,cl,request({status:'cancelled',reason:'Centre closed'}),manager));
    await assert.rejects(()=>quote(u,code));
    assert.equal((await balance(u,false)).points,0);
  });
});
