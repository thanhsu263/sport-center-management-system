-- 0048_seed_class_prices.sql: give the seeded classes a price so members can enrol.
-- Classes made before 0045 have no price and show "Not open yet". A price the manager set stays.

update classes
   set price_vnd = case level
                     when 'beginner' then 800000
                     when 'intermediate' then 1000000
                     else 1200000
                   end
 where price_vnd is null;
