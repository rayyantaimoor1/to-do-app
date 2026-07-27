-- RLS cross-user verification for M2.
-- Run each numbered block in the SQL Editor, in order. Read the comments —
-- step 1's output feeds into step 3.

-- 1. Find your real user id (run this first, copy the id)
select id, email from auth.users where email = 'rayyantaimoor9@gmail.com';

-- 2. Insert a task owned by a fake, unrelated user (this runs as postgres,
--    which bypasses RLS, so the insert succeeds regardless of policy)
insert into tasks (user_id, title, scope, due_at)
values (
  '00000000-0000-0000-0000-000000000001',
  'FAKE USER TASK - should never appear to the real user',
  'day',
  now()
);

-- 3. Simulate being logged in as the REAL user (paste the id from step 1)
--    and see what tasks are visible. This should show ONLY your own
--    tasks (e.g. whatever you created while testing the app), and must
--    NOT include the fake task from step 2.
set local role authenticated;
set local request.jwt.claims = '{"sub":"PASTE_REAL_USER_ID_HERE","role":"authenticated"}';
select id, title, user_id from tasks;
reset role;

-- 4. Simulate being logged in as the FAKE user and see what's visible to
--    them. This should show ONLY the fake task, and must NOT include any
--    of your real tasks.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}';
select id, title, user_id from tasks;
reset role;

-- 5. Clean up the fake row
delete from tasks where user_id = '00000000-0000-0000-0000-000000000001';
