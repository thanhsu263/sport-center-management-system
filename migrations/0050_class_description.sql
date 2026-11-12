-- 0050_class_description.sql: what a class is about, so a member can read it before enrolling.
-- description: a short paragraph. syllabus: one line per session or topic. who_for and bring: one line each.
-- Classes that already exist get a starter text from their sport and level; a text the manager wrote stays.

alter table classes add column if not exists description text null check (char_length(description) <= 2000);
alter table classes add column if not exists syllabus text null check (char_length(syllabus) <= 2000);
alter table classes add column if not exists who_for text null check (char_length(who_for) <= 300);
alter table classes add column if not exists bring text null check (char_length(bring) <= 300);

update classes cl
   set description = case cl.level
         when 'beginner' then 'A first course in ' || lower(s.name_en) || ' for people who have never played or only play for fun. '
           || 'You learn the grip, the stance and the basic strokes, then play short games with others at your level. '
           || 'Small groups, so the coach can correct each of you every session.'
         when 'intermediate' then 'For players who know the rules and can keep a rally going in ' || lower(s.name_en) || '. '
           || 'We clean up technique, add footwork and tactics, and play match situations so the skills hold up under pressure.'
         else 'A training group for confident ' || lower(s.name_en) || ' players who want to compete. '
           || 'Intense drills, match play with video feedback, and a plan for your weaker shots.'
       end,
       syllabus = case cl.level
         when 'beginner' then E'Grip, stance and ready position\nBasic strokes and control\nMoving on the court\nServing and receiving\nRules and scoring\nFriendly games to finish'
         when 'intermediate' then E'Technique check and fixes\nFootwork patterns\nAttack and defence\nDoubles positioning\nTactics in match situations\nMatch play with feedback'
         else E'Fitness and speed drills\nAdvanced shots\nReading the opponent\nMatch strategy\nVideo review\nTournament simulation'
       end,
       who_for = case cl.level
         when 'beginner' then 'New players, age 10 and up. No experience needed.'
         when 'intermediate' then 'Players who already know the basics and play regularly.'
         else 'Experienced players aiming for club or school competitions.'
       end,
       bring = 'Sports shoes with non-marking soles, comfortable clothes and a water bottle. Equipment can be borrowed at reception.'
  from sports s
 where s.code = cl.sport::text
   and cl.description is null;
