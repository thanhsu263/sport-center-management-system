-- 0035_media_library.sql
-- Curated media library and asset slots upgrade

CREATE TABLE IF NOT EXISTS media_library (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL DEFAULT 'image',
  category    TEXT NOT NULL,
  tags        TEXT[] NOT NULL DEFAULT '{}',
  width       INT,
  height      INT,
  alt_en      TEXT NOT NULL,
  alt_vi      TEXT NOT NULL,
  credit      TEXT,
  source_url  TEXT,
  license     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_media_library_category ON media_library(category);
CREATE INDEX IF NOT EXISTS idx_media_library_tags ON media_library USING gin(tags);

-- Seed Media Library Items
INSERT INTO media_library (id, path, kind, category, tags, width, height, alt_en, alt_vi, credit, source_url, license, created_at) VALUES
  ('legacy-athlete', 'athlete.jpg', 'image', 'legacy', '{"legacy","athlete"}', 1280, 720, 'Arena3 site asset: athlete', 'Tài nguyên Arena3: athlete', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-badminton-action', 'badminton-action.jpg', 'image', 'legacy', '{"legacy","badminton-action"}', 1280, 720, 'Arena3 site asset: badminton-action', 'Tài nguyên Arena3: badminton-action', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-badminton-court', 'badminton-court.jpg', 'image', 'legacy', '{"legacy","badminton-court"}', 1280, 720, 'Arena3 site asset: badminton-court', 'Tài nguyên Arena3: badminton-court', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-badminton-smash', 'badminton-smash.jpg', 'image', 'legacy', '{"legacy","badminton-smash"}', 1280, 720, 'Arena3 site asset: badminton-smash', 'Tài nguyên Arena3: badminton-smash', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-badminton', 'badminton.jpg', 'image', 'legacy', '{"legacy","badminton"}', 1280, 720, 'Arena3 site asset: badminton', 'Tài nguyên Arena3: badminton', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-badminton', 'badminton.mp4', 'video', 'legacy', '{"legacy","badminton"}', 1920, 1080, 'Arena3 site asset: badminton', 'Tài nguyên Arena3: badminton', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-basketball-action', 'basketball-action.jpg', 'image', 'legacy', '{"legacy","basketball-action"}', 1280, 720, 'Arena3 site asset: basketball-action', 'Tài nguyên Arena3: basketball-action', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-basketball', 'basketball.jpg', 'image', 'legacy', '{"legacy","basketball"}', 1280, 720, 'Arena3 site asset: basketball', 'Tài nguyên Arena3: basketball', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-class-group', 'class-group.jpg', 'image', 'legacy', '{"legacy","class-group"}', 1280, 720, 'Arena3 site asset: class-group', 'Tài nguyên Arena3: class-group', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-coach-anh', 'coach-anh.jpg', 'image', 'legacy', '{"legacy","coach-anh"}', 1280, 720, 'Arena3 site asset: coach-anh', 'Tài nguyên Arena3: coach-anh', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-coach-drill', 'coach-drill.jpg', 'image', 'legacy', '{"legacy","coach-drill"}', 1280, 720, 'Arena3 site asset: coach-drill', 'Tài nguyên Arena3: coach-drill', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-coach-khoa', 'coach-khoa.jpg', 'image', 'legacy', '{"legacy","coach-khoa"}', 1280, 720, 'Arena3 site asset: coach-khoa', 'Tài nguyên Arena3: coach-khoa', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-coach-lan', 'coach-lan.jpg', 'image', 'legacy', '{"legacy","coach-lan"}', 1280, 720, 'Arena3 site asset: coach-lan', 'Tài nguyên Arena3: coach-lan', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-coach-viet', 'coach-viet.jpg', 'image', 'legacy', '{"legacy","coach-viet"}', 1280, 720, 'Arena3 site asset: coach-viet', 'Tài nguyên Arena3: coach-viet', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-coach-whistle', 'coach-whistle.jpg', 'image', 'legacy', '{"legacy","coach-whistle"}', 1280, 720, 'Arena3 site asset: coach-whistle', 'Tài nguyên Arena3: coach-whistle', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-court-detail', 'court-detail.jpg', 'image', 'legacy', '{"legacy","court-detail"}', 1280, 720, 'Arena3 site asset: court-detail', 'Tài nguyên Arena3: court-detail', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-desk-gate', 'desk-gate.jpg', 'image', 'legacy', '{"legacy","desk-gate"}', 1280, 720, 'Arena3 site asset: desk-gate', 'Tài nguyên Arena3: desk-gate', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-empty-court', 'empty-court.jpg', 'image', 'legacy', '{"legacy","empty-court"}', 1280, 720, 'Arena3 site asset: empty-court', 'Tài nguyên Arena3: empty-court', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-exterior', 'exterior.jpg', 'image', 'legacy', '{"legacy","exterior"}', 1280, 720, 'Arena3 site asset: exterior', 'Tài nguyên Arena3: exterior', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-hall-courts', 'hall-courts.jpg', 'image', 'legacy', '{"legacy","hall-courts"}', 1280, 720, 'Arena3 site asset: hall-courts', 'Tài nguyên Arena3: hall-courts', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-hall', 'hall.jpg', 'image', 'legacy', '{"legacy","hall"}', 1280, 720, 'Arena3 site asset: hall', 'Tài nguyên Arena3: hall', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-hall', 'hall.mp4', 'video', 'legacy', '{"legacy","hall"}', 1920, 1080, 'Arena3 site asset: hall', 'Tài nguyên Arena3: hall', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('lib-badminton-badminton-court-blue-walls', 'library/badminton/badminton-court-blue-walls.jpg', 'image', 'badminton', '{"badminton","indoor","court","hall"}', 1920, 1080, 'Indoor badminton court with blue walls and professional floor', 'Sân cầu lông trong nhà với thảm xanh và tường xanh tiêu chuẩn', 'Palak Pitroda', 'https://unsplash.com/photos/indoor-badminton-court-with-blue-walls-and-floor-R3S6YdeHA6A', 'Unsplash License', '2026-10-17T15:05:54.033Z'),
  ('lib-badminton-badminton-doubles-play', 'library/badminton/badminton-doubles-play.jpg', 'image', 'badminton', '{"badminton","doubles","training","court"}', 1920, 1080, 'Two men playing badminton doubles on a blue court', 'Hai người tập luyện đánh cầu đôi trên sân xanh', 'Evan Marvell', 'https://unsplash.com/photos/two-men-playing-badminton-on-a-blue-court-CDko3AUxkOk', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-badminton-badminton-empty-courts-hall', 'library/badminton/badminton-empty-courts-hall.jpg', 'image', 'badminton', '{"badminton","empty","courts","hall"}', 1920, 1080, 'Empty indoor badminton courts with blue flooring in sports arena', 'Các sân cầu lông thảm xanh tiêu chuẩn còn trống trong nhà thi đấu', 'Palak Pitroda', 'https://unsplash.com/photos/empty-indoor-badminton-courts-with-blue-flooring-AILEpOyczIk', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-badminton-badminton-green-court-match', 'library/badminton/badminton-green-court-match.jpg', 'image', 'badminton', '{"badminton","green-court","match","rally"}', 1920, 1080, 'Badminton players competing on a green indoor court', 'Vận động viên thi đấu cầu lông trên sân thảm xanh lá', 'Irish83', 'https://unsplash.com/photos/badminton-players-on-a-green-court-framed-by-a-racket-C-MDfZ3svnQ', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-badminton-badminton-gymnasium-smash', 'library/badminton/badminton-gymnasium-smash.jpg', 'image', 'badminton', '{"badminton","smash","gymnasium","play"}', 1920, 1080, 'Player executing smash inside indoor sports gymnasium', 'Người chơi thực hiện cú đập cầu lông uy lực trong nhà thi đấu', 'Jackie Hutchinson', 'https://unsplash.com/photos/man-playing-badminton-inside-gymnasium-cZ8Xpnj773M', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-badminton-badminton-handshake-sportsmanship', 'library/badminton/badminton-handshake-sportsmanship.jpg', 'image', 'badminton', '{"badminton","handshake","sportsmanship","net"}', 1920, 1080, 'Badminton players shaking hands over net after match', 'Hai tay vợt bắt tay giao lưu bên lưới sau trận cầu lông', 'Irish83', 'https://unsplash.com/photos/two-men-shake-hands-on-an-indoor-badminton-court-5FMKW3Kj-7E', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-badminton-badminton-indoor-court-wide', 'library/badminton/badminton-indoor-court-wide.jpg', 'image', 'badminton', '{"badminton","indoor","court","rally","blue"}', 1920, 1080, 'Four people playing badminton on a blue indoor court', 'Bốn người chơi cầu lông trên sân thảm xanh trong nhà', 'Evan Marvell', 'https://unsplash.com/photos/four-people-playing-badminton-on-a-blue-indoor-court-0Zq9PQJvEv8', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-badminton-badminton-indoor-sparring', 'library/badminton/badminton-indoor-sparring.jpg', 'image', 'badminton', '{"badminton","sparring","indoor","action"}', 1920, 1080, 'Two athletes sparring on an indoor badminton court', 'Hai vận động viên thi đấu đối kháng cầu lông trong nhà', 'Irish83', 'https://unsplash.com/photos/two-men-playing-badminton-on-an-indoor-court-_T5XxFIntfI', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-badminton-badminton-racket-focus-action', 'library/badminton/badminton-racket-focus-action.jpg', 'image', 'badminton', '{"badminton","action","racket","focus"}', 1920, 1080, 'Badminton action shot on green court viewed through racket', 'Pha đánh cầu kịch tính nhìn xuyên qua khung dây vợt', 'Irish83', 'https://unsplash.com/photos/badminton-player-on-a-green-court-viewed-through-a-racket-MLjj5eVwrvI', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-badminton-badminton-racket-frame-view', 'library/badminton/badminton-racket-frame-view.jpg', 'image', 'badminton', '{"badminton","racket","indoor","players"}', 1920, 1080, 'Badminton players on an indoor court framed through a racket', 'Góc nhìn qua khung vợt cầu lông trên sân tập trong nhà', 'Irish83', 'https://unsplash.com/photos/badminton-players-on-an-indoor-court-through-a-racket-pRUw9c66zJA', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-badminton-badminton-rally-action', 'library/badminton/badminton-rally-action.jpg', 'image', 'badminton', '{"badminton","rally","action","doubles"}', 1920, 1080, 'Dynamic fast-paced badminton doubles rally', 'Pha đôi công tốc độ cao hấp dẫn trên sân', 'Ryan Searle', 'https://unsplash.com/photos/Ryan-Searle', 'Unsplash License', '2026-10-17T13:10:34.825Z'),
  ('lib-badminton-badminton-shuttlecock-on-net', 'library/badminton/badminton-shuttlecock-on-net.jpg', 'image', 'badminton', '{"badminton","shuttlecock","net","close-up"}', 1920, 1080, 'Feather shuttlecock balanced on badminton net cord', 'Quả cầu lông vũ đặt tinh tế trên mép lưới', 'Mukul Wadhwa', 'https://unsplash.com/photos/Mukul-Wadhwa', 'Unsplash License', '2026-10-17T13:10:34.825Z'),
  ('lib-basketball-basketball-court-hardwood', 'library/basketball/basketball-court-hardwood.jpg', 'image', 'basketball', '{"basketball","court","hardwood","hoop"}', 1920, 1080, 'Classic indoor hardwood basketball court and hoop', 'Sân bóng rổ sàn gỗ phong chuyên dụng và bảng rổ', 'TJ Dragotta', 'https://unsplash.com/photos/TJ-Dragotta', 'Unsplash License', '2026-10-17T13:10:34.826Z'),
  ('lib-basketball-basketball-fast-break-pass', 'library/basketball/basketball-fast-break-pass.jpg', 'image', 'basketball', '{"basketball","fast-break","passing","court"}', 1920, 1080, 'Players passing and executing fast break on basketball court', 'Nhóm cầu thủ chuyền bóng phản công nhanh trên sân bóng rổ', 'Alejandro Stuardo', 'https://unsplash.com/photos/men-playing-basketball-on-indoor-court-nuJv9_RvJrk', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-basketball-basketball-indoor-wooden-court', 'library/basketball/basketball-indoor-wooden-court.jpg', 'image', 'basketball', '{"basketball","indoor","court","wooden","game"}', 1920, 1080, 'Five players competing in a basketball game on an indoor wooden court', 'Năm cầu thủ thi đấu bóng rổ trên sàn gỗ trong nhà', 'Alejandro Stuardo', 'https://unsplash.com/photos/basketball-game-on-indoor-court-5mdjIGl4QBk', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-basketball-basketball-jump-shot-drive', 'library/basketball/basketball-jump-shot-drive.jpg', 'image', 'basketball', '{"basketball","jump-shot","arena","player"}', 1920, 1080, 'Basketball player jumping to shoot towards the hoop in arena', 'Cầu thủ bật cao tung cú ném rổ chuẩn xác trong nhà thi đấu', 'Alejandro Stuardo', 'https://unsplash.com/photos/basketball-player-shooting-in-gym-JGkFkgpfz2I', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-basketball-basketball-layup-score', 'library/basketball/basketball-layup-score.jpg', 'image', 'basketball', '{"basketball","layup","score","drive"}', 1920, 1080, 'Basketball player driving to basket to score in arena', 'Vận động viên đột phá lên rổ ghi điểm trong nhà thi đấu', 'Alejandro Stuardo', 'https://unsplash.com/photos/basketball-player-scoring-in-sports-arena--yAr6zXba1g', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-basketball-basketball-loose-ball-contest', 'library/basketball/basketball-loose-ball-contest.jpg', 'image', 'basketball', '{"basketball","competition","contest","possession"}', 1920, 1080, 'Basketball players competing intensely for ball possession', 'Các vận động viên tranh chấp bóng quyết liệt trên sàn đấu', 'Alejandro Stuardo', 'https://unsplash.com/photos/basketball-players-competing-on-indoor-court-3Bi5W4v80T8', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-basketball-basketball-on-court', 'library/basketball/basketball-on-court.jpg', 'image', 'basketball', '{"basketball","ball","parquet","court"}', 1920, 1080, 'Basketball resting on polished parquet court lines', 'Quả bóng rổ đặt trên sàn gỗ vạch sơn bóng loáng', 'Tom Rogerson', 'https://unsplash.com/photos/Tom-Rogerson', 'Unsplash License', '2026-10-17T13:10:34.826Z'),
  ('lib-basketball-basketball-practice-hall', 'library/basketball/basketball-practice-hall.jpg', 'image', 'basketball', '{"basketball","practice","hall","gym"}', 1920, 1080, 'Atmospheric indoor basketball practice gym', 'Nhà tập bóng rổ tràn ngập ánh sáng năng động', 'Tim Gouw', 'https://unsplash.com/photos/Tim-Gouw', 'Unsplash License', '2026-10-17T13:10:34.826Z'),
  ('lib-basketball-basketball-referee-court-action', 'library/basketball/basketball-referee-court-action.jpg', 'image', 'basketball', '{"basketball","match","referee","action"}', 1920, 1080, 'Basketball match action on wooden court under referee supervision', 'Tranh chấp bóng rổ trên sân gỗ dưới sự quan sát của trọng tài', 'Alejandro Stuardo', 'https://unsplash.com/photos/basketball-game-on-indoor-court-cuzdI5jubVg', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-basketball-basketball-swish-net', 'library/basketball/basketball-swish-net.jpg', 'image', 'basketball', '{"basketball","swish","net","shot"}', 1920, 1080, 'Basketball swooshing cleanly through nylon net', 'Cú ném bóng lọt lưới dứt khoát hoàn hảo', 'Markus Spiske', 'https://unsplash.com/photos/Markus-Spiske', 'Unsplash License', '2026-10-17T13:10:34.826Z'),
  ('lib-basketball-basketball-team-tactical-play', 'library/basketball/basketball-team-tactical-play.jpg', 'image', 'basketball', '{"basketball","tactics","teamwork","play"}', 1920, 1080, 'Three basketball players setting up tactical play on court', 'Ba cầu thủ phối hợp triển khai chiến thuật tấn công trên sân', 'Alejandro Stuardo', 'https://unsplash.com/photos/basketball-players-on-indoor-court-IYqY7y0Npkc', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-basketball-basketball-training-drills', 'library/basketball/basketball-training-drills.jpg', 'image', 'basketball', '{"basketball","training","drills","shooting"}', 1920, 1080, 'Basketball players practicing shooting drills on indoor court', 'Các vận động viên tập luyện ném rổ và phối hợp trên sân', 'Tim Ren', 'https://unsplash.com/photos/basketball-players-are-practicing-and-playing-on-the-court-3MfzD21eVMY', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-basketball-basketball-underpass-court', 'library/basketball/basketball-underpass-court.jpg', 'image', 'basketball', '{"basketball","urban","hoop","court"}', 1920, 1080, 'Urban basketball backboard and hoop on illuminated court', 'Sân bóng rổ đô thị với bảng rổ và vòng rổ tiêu chuẩn', 'Unsplash Contributor', 'https://unsplash.com/photos/urban-basketball-court', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-class-class-barbell-back-squat', 'library/class/class-barbell-back-squat.jpg', 'image', 'class', '{"class","back-squat","barbell","strength"}', 1920, 1080, 'Athlete performing heavy barbell back squats in gym', 'Vận động viên thực hiện bài tập gánh tạ đòn sau lưng trong phòng gym', 'Unsplash Contributor', 'https://unsplash.com/photos/barbell-back-squat', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-class-class-barbell-deadlift-training', 'library/class/class-barbell-deadlift-training.jpg', 'image', 'class', '{"class","barbell","deadlift","grip"}', 1920, 1080, 'Athlete gripping loaded Olympic barbell on rubber floor', 'Vận động viên nắm thanh đòn Olympic trên sàn cao su phòng tập', 'Unsplash Contributor', 'https://unsplash.com/photos/barbell-deadlift-training', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-class-class-coach-instruction-drill', 'library/class/class-coach-instruction-drill.jpg', 'image', 'class', '{"class","coach","drill","technique"}', 1920, 1080, 'Coach guiding technique and stance drill', 'Huấn luyện viên hướng dẫn tư thế và kỹ thuật', 'Benjamin Klaver', 'https://unsplash.com/photos/Benjamin-Klaver', 'Unsplash License', '2026-10-17T13:10:34.826Z'),
  ('lib-class-class-functional-agility-class', 'library/class/class-functional-agility-class.jpg', 'image', 'class', '{"class","agility","functional","movement"}', 1920, 1080, 'Functional sports movement class on indoor court', 'Lớp học vận động chức năng trên sân thể thao', 'Karsten Winegeart', 'https://unsplash.com/photos/Karsten-Winegeart', 'Unsplash License', '2026-10-17T13:10:34.826Z'),
  ('lib-class-class-group-fitness-mat-workout', 'library/class/class-group-fitness-mat-workout.jpg', 'image', 'class', '{"class","group-fitness","mat","conditioning"}', 1920, 1080, 'Group exercise class performing mat conditioning drills', 'Lớp tập luyện thể hình nhóm trên thảm tập trong phòng tập', 'Unsplash Contributor', 'https://unsplash.com/photos/group-fitness-class', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-class-class-movement-drills', 'library/class/class-movement-drills.jpg', 'image', 'class', '{"class","drills","footwork","positioning"}', 1920, 1080, 'Footwork and court positioning training drills', 'Bài tập di chuyển bước chân và định vị sân', 'Danielle Cerullo', 'https://unsplash.com/photos/Danielle-Cerullo', 'Unsplash License', '2026-10-17T13:10:34.826Z'),
  ('lib-class-class-one-on-one-coaching', 'library/class/class-one-on-one-coaching.jpg', 'image', 'class', '{"class","personal","coaching","one-on-one"}', 1920, 1080, 'One-on-one personalized coaching session', 'Buổi hướng dẫn cá nhân chuyên sâu cùng huấn luyện viên', 'Benjamin Klaver', 'https://unsplash.com/photos/Benjamin-Klaver', 'Unsplash License', '2026-10-17T13:10:34.826Z'),
  ('lib-class-class-overhead-barbell-press', 'library/class/class-overhead-barbell-press.jpg', 'image', 'class', '{"class","overhead-press","barbell","strength"}', 1920, 1080, 'Athlete executing barbell overhead press in training rack', 'Nữ vận động viên thực hiện bài đẩy tạ đòn qua đầu', 'Unsplash Contributor', 'https://unsplash.com/photos/barbell-overhead-press', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-class-class-pullups-conditioning', 'library/class/class-pullups-conditioning.jpg', 'image', 'class', '{"class","pullups","conditioning","strength"}', 1920, 1080, 'Muscular athlete performing pull-ups conditioning', 'Vận động viên kéo xà đơn rèn luyện sức mạnh thể lực', 'Unsplash Contributor', 'https://unsplash.com/photos/pullups-conditioning', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-class-class-stability-ball-stretch', 'library/class/class-stability-ball-stretch.jpg', 'image', 'class', '{"class","stability-ball","stretch","fitness"}', 1920, 1080, 'Athlete stretching back over fitness Swiss ball', 'Vận động viên giãn cơ lưng với bóng thăng bằng thể hình', 'Unsplash Contributor', 'https://unsplash.com/photos/stability-ball-stretch', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-class-class-strength-deadlift-drill', 'library/class/class-strength-deadlift-drill.jpg', 'image', 'class', '{"class","deadlift","drill","strength"}', 1920, 1080, 'Athlete in deadlift lift stance with barbell weights', 'Tư thế nâng tạ đòn deadlift chuẩn xác trong bài tập thể lực', 'Unsplash Contributor', 'https://unsplash.com/photos/strength-deadlift-drill', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-class-class-team-conditioning', 'library/class/class-team-conditioning.jpg', 'image', 'class', '{"class","conditioning","team","workout"}', 1920, 1080, 'Indoor athletic team conditioning workout', 'Bài tập thể lực và sức bền đồng đội trong nhà', 'Bruce Mars', 'https://unsplash.com/photos/Bruce-Mars', 'Unsplash License', '2026-10-17T13:10:34.826Z'),
  ('lib-class-class-tricep-strength-workout', 'library/class/class-tricep-strength-workout.jpg', 'image', 'class', '{"class","tricep","strength","workout"}', 1920, 1080, 'Athlete performing tricep cable pushdown exercise in gym', 'Vận động viên thực hiện bài tập kéo cáp cơ tay sau trong phòng tập', 'Unsplash Contributor', 'https://unsplash.com/photos/tricep-cable-workout', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-class-class-youth-academy-session', 'library/class/class-youth-academy-session.jpg', 'image', 'class', '{"class","youth","academy","skills"}', 1920, 1080, 'Youth sports academy foundation skills training', 'Lớp đào tạo kỹ năng nền tảng cho học viên trẻ', 'Geert Pieters', 'https://unsplash.com/photos/Geert-Pieters', 'Unsplash License', '2026-10-17T13:10:34.826Z'),
  ('lib-coach-coach-asian-athlete-stretching', 'library/coach/coach-asian-athlete-stretching.jpg', 'image', 'coach', '{"coach","stretching","court","portrait"}', 900, 1125, 'Athletic coach stretching on court', 'Huấn luyện viên khởi động giãn cơ trên sân', 'Form', 'https://unsplash.com/photos/Form', 'Unsplash License', '2026-10-16T07:55:38.645Z'),
  ('lib-coach-coach-asian-female-trainer', 'library/coach/coach-asian-female-trainer.jpg', 'image', 'coach', '{"coach","fitness","female","portrait"}', 900, 1125, 'Athletic coach portrait in sportswear', 'Chân dung huấn luyện viên nữ trong trang phục thể thao', 'Valerie Elash', 'https://unsplash.com/photos/Valerie-Elash', 'Unsplash License', '2026-10-16T07:55:38.416Z'),
  ('lib-coach-coach-asian-sports-woman', 'library/coach/coach-asian-sports-woman.jpg', 'image', 'coach', '{"coach","sports","female","portrait"}', 900, 1125, 'Active female sports coach portrait', 'Chân dung huấn luyện viên thể thao nữ năng động', 'Courtney Cook', 'https://unsplash.com/photos/Courtney-Cook', 'Unsplash License', '2026-10-16T07:55:39.202Z'),
  ('lib-coach-coach-badminton-instructor-male', 'library/coach/coach-badminton-instructor-male.jpg', 'image', 'coach', '{"coach","dedicated","portrait"}', 900, 1125, 'Dedicated sports coach portrait', 'Chân dung huấn luyện viên thể thao tâm huyết', 'Stefan Stefancik', 'https://unsplash.com/photos/Stefan-Stefancik', 'Unsplash License', '2026-10-16T07:55:39.427Z'),
  ('lib-coach-coach-fitness-gym-trainer', 'library/coach/coach-fitness-gym-trainer.jpg', 'image', 'coach', '{"coach","fitness","gym","portrait"}', 900, 1125, 'Fitness trainer ready for training session', 'Huấn luyện viên thể hình sẵn sàng cho buổi tập', 'Benjamin Klaver', 'https://unsplash.com/photos/Benjamin-Klaver', 'Unsplash License', '2026-10-16T07:55:38.779Z'),
  ('lib-coach-coach-indoor-sports-trainer', 'library/coach/coach-indoor-sports-trainer.jpg', 'image', 'coach', '{"coach","indoor","gear","portrait"}', 900, 1125, 'Indoor sports coach with athletic gear', 'Huấn luyện viên thể thao trong nhà với trang thiết bị tập luyện', 'Karsten Winegeart', 'https://unsplash.com/photos/Karsten-Winegeart', 'Unsplash License', '2026-10-16T07:55:39.018Z'),
  ('lib-coach-coach-le-quoc-viet', 'library/coach/coach-le-quoc-viet.jpg', 'image', 'coach', '{"coach","volleyball","male","portrait"}', 900, 1125, 'Coach Le Quoc Viet portrait, volleyball coach', 'Chân dung HLV bóng chuyền Lê Quốc Việt', 'Warren Wong', 'https://unsplash.com/photos/Warren-Wong', 'Unsplash License', '2026-10-16T07:55:38.091Z'),
  ('lib-coach-coach-minh-quan', 'library/coach/coach-minh-quan.jpg', 'image', 'coach', '{"coach","fitness","conditioning","portrait"}', 900, 1125, 'Coach Minh Quan portrait, fitness and conditioning coach', 'Chân dung HLV thể lực Minh Quân', 'Albert Dera', 'https://unsplash.com/photos/Albert-Dera', 'Unsplash License', '2026-10-16T07:55:38.231Z'),
  ('lib-coach-coach-nguyen-minh-khoa', 'library/coach/coach-nguyen-minh-khoa.jpg', 'image', 'coach', '{"coach","badminton","head-coach","portrait"}', 900, 1125, 'Coach Nguyen Minh Khoa portrait, badminton head coach', 'Chân dung HLV trưởng cầu lông Nguyễn Minh Khoa', 'Joseph Gonzalez', 'https://unsplash.com/photos/Joseph-Gonzalez', 'Unsplash License', '2026-10-16T07:55:37.358Z'),
  ('lib-coach-coach-pham-duc-anh', 'library/coach/coach-pham-duc-anh.jpg', 'image', 'coach', '{"coach","basketball","male","portrait"}', 900, 1125, 'Coach Pham Duc Anh portrait, basketball coach', 'Chân dung HLV bóng rổ Phạm Đức Anh', 'Jurica Koletić', 'https://unsplash.com/photos/Jurica-Koletic', 'Unsplash License', '2026-10-16T07:55:37.912Z'),
  ('lib-coach-coach-professional-athletic-female', 'library/coach/coach-professional-athletic-female.jpg', 'image', 'coach', '{"coach","professional","portrait"}', 900, 1125, 'Professional athletic coach portrait', 'Chân dung huấn luyện viên chuyên nghiệp', 'Christian Buehner', 'https://unsplash.com/photos/Christian-Buehner', 'Unsplash License', '2026-10-16T07:55:39.316Z'),
  ('lib-coach-coach-sports-conditioning-man', 'library/coach/coach-sports-conditioning-man.jpg', 'image', 'coach', '{"coach","strength","conditioning","portrait"}', 900, 1125, 'Strength and conditioning coach portrait', 'Chân dung huấn luyện viên thể lực và sức mạnh', 'Alora Griffiths', 'https://unsplash.com/photos/Alora-Griffiths', 'Unsplash License', '2026-10-16T07:55:38.911Z'),
  ('lib-coach-coach-tran-thi-lan', 'library/coach/coach-tran-thi-lan.jpg', 'image', 'coach', '{"coach","badminton","female","portrait"}', 900, 1125, 'Coach Tran Thi Lan portrait, badminton junior coach', 'Chân dung HLV cầu lông Trần Thị Lan', 'Averie Woodard', 'https://unsplash.com/photos/Averie-Woodard', 'Unsplash License', '2026-10-16T07:55:37.712Z'),
  ('lib-coach-coach-young-athlete-trainer', 'library/coach/coach-young-athlete-trainer.jpg', 'image', 'coach', '{"coach","athletic","male","portrait"}', 900, 1125, 'Young athletic trainer portrait', 'Chân dung huấn luyện viên trẻ năng động', 'Brooke Cagle', 'https://unsplash.com/photos/Brooke-Cagle', 'Unsplash License', '2026-10-16T07:55:38.537Z'),
  ('lib-equipment-equipment-1-shuttlecocks-yonex-aerosensa-20', 'library/equipment/equipment-1-shuttlecocks-yonex-aerosensa-20.jpg', 'image', 'equipment', '{"equipment","equipment"}', 1024, 1365, 'equipment: Shuttlecocks Yonex Aerosensa 20', 'Hình ảnh equipment: Shuttlecocks Yonex Aerosensa 20', 'Arne Nordmann (user:norro), Germany', 'https://commons.wikimedia.org/wiki/File%3AShuttlecocks%20Yonex%20Aerosensa%2020.jpg', 'CC BY-SA 3.0', '2026-10-16T07:58:08.177Z'),
  ('lib-equipment-equipment-2-volant-badminton', 'library/equipment/equipment-2-volant-badminton.jpg', 'image', 'equipment', '{"equipment","equipment"}', 1024, 768, 'equipment: Volant badminton', 'Hình ảnh equipment: Volant badminton', 'No machine-readable author provided. Badplayer~commonswiki assumed (based on copyright claims).', 'https://commons.wikimedia.org/wiki/File%3AVolant%20badminton.jpg', 'CC BY-SA 2.5', '2026-10-16T07:58:09.062Z'),
  ('lib-equipment-equipment-3-koogan-badminton-feather-shuttlecoc', 'library/equipment/equipment-3-koogan-badminton-feather-shuttlecoc.jpg', 'image', 'equipment', '{"equipment","equipment"}', 1024, 768, 'equipment: Koogan badminton feather shuttlecock 01', 'Hình ảnh equipment: Koogan badminton feather shuttlecock 01', 'Stanislas PERRIN', 'https://commons.wikimedia.org/wiki/File%3AKoogan%20badminton%20feather%20shuttlecock%2001.JPG', 'Public domain', '2026-10-16T07:58:09.294Z'),
  ('lib-equipment-equipment-4-speeder-match', 'library/equipment/equipment-4-speeder-match.jpg', 'image', 'equipment', '{"equipment","equipment"}', 1024, 834, 'equipment: Speeder-match', 'Hình ảnh equipment: Speeder-match', 'Pierre alex', 'https://commons.wikimedia.org/wiki/File%3ASpeeder-match.jpg', 'CC BY-SA 3.0', '2026-10-16T07:58:10.023Z'),
  ('lib-equipment-equipment-5-fjerbolde', 'library/equipment/equipment-5-fjerbolde.jpg', 'image', 'equipment', '{"equipment","equipment"}', 1024, 819, 'equipment: Fjerbolde', 'Hình ảnh equipment: Fjerbolde', 'Hansjorn at da.wikipedia', 'https://commons.wikimedia.org/wiki/File%3AFjerbolde.jpg', 'CC BY-SA 3.0', '2026-10-16T07:58:10.935Z'),
  ('lib-equipment-equipment-6-badminton-1', 'library/equipment/equipment-6-badminton-1.jpg', 'image', 'equipment', '{"equipment","equipment"}', 1024, 642, 'equipment: Badminton 1', 'Hình ảnh equipment: Badminton 1', 'Kaparycha Konstantin at cs.wikipedia', 'https://commons.wikimedia.org/wiki/File%3ABadminton%201.jpg', 'Public domain', '2026-10-16T07:58:11.523Z'),
  ('lib-equipment-equipment-7-speeder', 'library/equipment/equipment-7-speeder.jpg', 'image', 'equipment', '{"equipment","equipment"}', 1024, 784, 'equipment: Speeder', 'Hình ảnh equipment: Speeder', 'Martin Thoma (MartinThoma at de.wikipedia)', 'https://commons.wikimedia.org/wiki/File%3ASpeeder.jpg', 'Public domain', '2026-10-16T07:58:12.262Z'),
  ('lib-equipment-equipment-8-chien-volant-badminton', 'library/equipment/equipment-8-chien-volant-badminton.jpg', 'image', 'equipment', '{"equipment","equipment"}', 1024, 876, 'equipment: Chien volant badminton', 'Hình ảnh equipment: Chien volant badminton', 'Fabien Foixet', 'https://commons.wikimedia.org/wiki/File%3AChien%20volant%20badminton.jpg', 'CC BY-SA 3.0', '2026-10-16T07:58:15.860Z'),
  ('lib-equipment-equipment-barbell-grip-close-up', 'library/equipment/equipment-barbell-grip-close-up.jpg', 'image', 'equipment', '{"equipment","barbell","grip","close-up"}', 1920, 1080, 'Close-up of hand gripping knurled Olympic barbell with weight plate', 'Cận cảnh bàn tay nắm thanh tạ đòn Olympic và bánh tạ', 'Unsplash Contributor', 'https://unsplash.com/photos/barbell-grip-close-up', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-equipment-equipment-dumbbells-rack', 'library/equipment/equipment-dumbbells-rack.jpg', 'image', 'equipment', '{"equipment","dumbbells","rack","gym"}', 1920, 1080, 'Rows of black dumbbells arranged on gym equipment rack', 'Giá tạ tay chuyên dụng sắp xếp gọn gàng trong phòng gym', 'Unsplash Contributor', 'https://unsplash.com/photos/gym-dumbbells-rack', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-equipment-equipment-resistance-band-dumbbells', 'library/equipment/equipment-resistance-band-dumbbells.jpg', 'image', 'equipment', '{"equipment","resistance-band","dumbbells","fitness"}', 1920, 1080, 'Resistance training band and hand dumbbells on wooden floor', 'Dây kháng lực và tạ tay tập luyện thể lực trên sàn gỗ', 'Unsplash Contributor', 'https://unsplash.com/photos/resistance-band-dumbbells', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-event-event-ceremony-hall-gathering', 'library/event/event-ceremony-hall-gathering.jpg', 'image', 'event', '{"event","ceremony","gathering","hall"}', 1920, 1080, 'Athletes and spectators gathered in tournament hall during ceremony', 'Các đoàn vận động viên và khán giả tề tựu tại lễ khai mạc giải đấu', 'MERLIN S', 'https://unsplash.com/photos/people-standing-in-a-large-hall-during-an-event-Wh401Qh2HSk', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-event-event-championship-arena', 'library/event/event-championship-arena.jpg', 'image', 'event', '{"event","tournament","championship","floodlights"}', 1920, 1080, 'Championship tournament court with floodlights', 'Sân đấu giải vô địch rực sáng dưới dàn đèn thi đấu', 'Braden Collum', 'https://unsplash.com/photos/Braden-Collum', 'Unsplash License', '2026-10-17T13:10:34.826Z'),
  ('lib-event-event-championship-sports-hall', 'library/event/event-championship-sports-hall.jpg', 'image', 'event', '{"event","championship","competition","arena"}', 1920, 1080, 'Championship competition game in indoor multi-sport arena', 'Trận tranh chức vô địch sôi nổi trong nhà thi đấu đa năng', 'Alejandro Stuardo', 'https://unsplash.com/photos/volleyball-match-in-indoor-sports-hall-5lOYEGsM4ZQ', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-event-event-tournament-final-match', 'library/event/event-tournament-final-match.jpg', 'image', 'event', '{"event","final","tournament","showdown"}', 1920, 1080, 'Final tournament showdown on indoor court', 'Trận chung kết giải đấu thể thao trên sân trong nhà', 'Alejandro Stuardo', 'https://unsplash.com/photos/volleyball-match-on-indoor-wooden-court-GVpsBRLJZ1A', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-event-event-tournament-spectator-crowd', 'library/event/event-tournament-spectator-crowd.jpg', 'image', 'event', '{"event","spectators","crowd","cheering"}', 1920, 1080, 'Audience and spectators cheering during tournament event', 'Khán giả cổ vũ sôi nổi tại sự kiện thể thao trong hội trường', 'Ufoma Ojo', 'https://unsplash.com/photos/a-large-group-of-people-gathered-in-an-auditorium-V8Z-RdGs5M8', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-event-event-tournament-spectator-hall', 'library/event/event-tournament-spectator-hall.jpg', 'image', 'event', '{"event","spectators","crowd","finals"}', 1920, 1080, 'Excited spectator crowd watching final match', 'Khán giả hào hứng cổ vũ trận chung kết kịch tính', 'Florian Olivo', 'https://unsplash.com/photos/Florian-Olivo', 'Unsplash License', '2026-10-17T13:10:34.826Z'),
  ('lib-event-event-volleyball-championship-hall', 'library/event/event-volleyball-championship-hall.jpg', 'image', 'event', '{"event","tournament","volleyball","match"}', 1920, 1080, 'Volleyball tournament match in full swing in sports hall', 'Trận thi đấu giải bóng chuyền sôi nổi trong nhà thi đấu', 'Alejandro Stuardo', 'https://unsplash.com/photos/volleyball-match-on-indoor-wooden-court-Hic3ZZPen2o', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-event-event-volleyball-trophies-ceremony', 'library/event/event-volleyball-trophies-ceremony.jpg', 'image', 'event', '{"event","trophy","ceremony","volleyball","award"}', 1920, 1080, 'Award ceremony table with volleyball tournament trophies in arena', 'Bàn trao giải với cúp vô địch bóng chuyền trong nhà thi đấu', 'Luis Dejud', 'https://unsplash.com/photos/people-with-volleyball-trophies-at-ceremony-qEj65xKmTZ4', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-facility-facility-arena-competition-mats', 'library/facility/facility-arena-competition-mats.jpg', 'image', 'facility', '{"facility","stadium","competition","mats"}', 1920, 1080, 'Indoor sports hall with competition floor and spectator stands', 'Nhà thi đấu đa năng trải sàn thi đấu chuyên nghiệp và khán đài', 'ARTO SURAJ', 'https://unsplash.com/photos/empty-indoor-stadium-with-blue-and-red-mat-pKU2ydvsysM', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-facility-facility-arena-exterior-entrance', 'library/facility/facility-arena-exterior-entrance.jpg', 'image', 'facility', '{"facility","exterior","entrance","building"}', 1920, 1080, 'Modern glass frontage and entrance of Arena3 complex', 'Mặt tiền hiện đại và lối vào trung tâm thể thao Arena3', 'Maxime', 'https://unsplash.com/photos/Maxime', 'Unsplash License', '2026-10-17T13:10:34.826Z'),
  ('lib-facility-facility-arena-grandstand-hall', 'library/facility/facility-arena-grandstand-hall.jpg', 'image', 'facility', '{"facility","arena","grandstand","court","hall"}', 1920, 1080, 'Empty indoor sports arena with spectator seating and court markings', 'Toàn cảnh nhà thi đấu thể thao đa năng với khán đài và mặt sân tiêu chuẩn', 'ARTO SURAJ', 'https://unsplash.com/photos/empty-indoor-sports-arena-with-seating-and-court-markings-okCrVJ6hI7o', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-facility-facility-arena-red-seating', 'library/facility/facility-arena-red-seating.jpg', 'image', 'facility', '{"facility","arena","seating","stadium"}', 1920, 1080, 'Multi-sport arena with red stadium seats and tournament floor', 'Khu phức hợp thể thao với hàng ghế khán đài đỏ và sàn thi đấu', 'ARTO SURAJ', 'https://unsplash.com/photos/empty-indoor-sports-arena-with-red-seating-and-blue-mats-lU2hfJSVSDI', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-facility-facility-cardio-gym-studio', 'library/facility/facility-cardio-gym-studio.jpg', 'image', 'facility', '{"facility","cardio","gym","bikes"}', 1920, 1080, 'Modern gym facility with stationary bikes and strength equipment', 'Phòng tập thể thao với xe đạp tập và máy tập thể lực hiện đại', 'Unsplash Contributor', 'https://unsplash.com/photos/gym-cardio-studio', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-facility-facility-court-spectator-benches', 'library/facility/facility-court-spectator-benches.jpg', 'image', 'facility', '{"facility","seating","viewing","spectators"}', 1920, 1080, 'Indoor court with tiered viewing seating for spectators', 'Khu vực khán đài bậc thang dành cho khán giả cổ vũ các trận đấu', 'Jonathan Ikemura', 'https://unsplash.com/photos/a-basketball-court-with-rows-of-empty-seats-k7JFRw2keyo', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-facility-facility-fitness-studio', 'library/facility/facility-fitness-studio.jpg', 'image', 'facility', '{"facility","fitness","studio","gym","treadmills"}', 1920, 1080, 'Modern fitness studio with treadmills and weight machines', 'Phòng tập thể hình với máy chạy bộ và trang thiết bị hiện đại', 'Unsplash Contributor', 'https://unsplash.com/photos/gym-fitness-studio', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-facility-facility-free-weights-area', 'library/facility/facility-free-weights-area.jpg', 'image', 'facility', '{"facility","free-weights","dumbbells","area"}', 1920, 1080, 'Free weights area with dumbbell rack and workout floor', 'Khu vực tập tạ tự do với các giá tạ tay và sàn tập chuyên dụng', 'Unsplash Contributor', 'https://unsplash.com/photos/gym-free-weights-area', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-facility-facility-hardwood-gym-hall', 'library/facility/facility-hardwood-gym-hall.jpg', 'image', 'facility', '{"facility","hardwood","gym","hall"}', 1920, 1080, 'Spacious indoor sports gymnasium with polished hardwood flooring', 'Nhà tập luyện thể thao rộng lớn với sàn gỗ đánh bóng cao cấp', 'Dmitry Ant', 'https://unsplash.com/photos/a-large-indoor-gym-with-hard-wood-flooring-Ft1VsaXvnRc', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-facility-facility-indoor-court-markings', 'library/facility/facility-indoor-court-markings.jpg', 'image', 'facility', '{"facility","court-markings","lines","floor"}', 1920, 1080, 'Crisp professional court markings on indoor athletic floor', 'Đường kẻ sân thi đấu sắc nét trên nền sàn thể thao chuyên dụng', 'Andy Kuo', 'https://unsplash.com/photos/an-indoor-basketball-court-with-green-and-yellow-lines-ef4g4xpLouI', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-facility-facility-indoor-spectator-tier', 'library/facility/facility-indoor-spectator-tier.jpg', 'image', 'facility', '{"facility","grandstand","seating","tier"}', 1920, 1080, 'Indoor arena grandstand seating and competition court view', 'Khu vực khán đài và tầm nhìn bao quát toàn bộ sàn thi đấu trong nhà', 'ARTO SURAJ', 'https://unsplash.com/photos/empty-indoor-sports-arena-with-spectator-seating-_XlTp6nHbm0', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-facility-facility-locker-room', 'library/facility/facility-locker-room.jpg', 'image', 'facility', '{"facility","locker","room","changing"}', 1920, 1080, 'Clean and secure athlete locker room facilities', 'Phòng thay đồ tiện nghi và an toàn cho vận động viên', 'Sanholic', 'https://unsplash.com/photos/Sanholic', 'Unsplash License', '2026-10-17T13:10:34.826Z'),
  ('lib-facility-facility-multi-court-arena-view', 'library/facility/facility-multi-court-arena-view.jpg', 'image', 'facility', '{"facility","overview","bleachers","complex"}', 1920, 1080, 'Panoramic overview of indoor sports complex courts and bleachers', 'Toàn cảnh các sân thể thao và khán đài trong khu liên hợp thể thao', 'Irish83', 'https://unsplash.com/photos/badminton-court-in-indoor-sports-arena-6qTZBVH2h4Y', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-facility-facility-sports-hall-flooring', 'library/facility/facility-sports-hall-flooring.jpg', 'image', 'facility', '{"facility","floor","court","sports-hall"}', 1920, 1080, 'Sports arena multi-purpose court floor surface', 'Mặt sàn thi đấu thảm chuyên dụng trong nhà thể thao đa năng', 'ARTO SURAJ', 'https://unsplash.com/photos/empty-indoor-sports-arena-with-blue-and-red-matting-Mll0kFmv8y4', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-facility-facility-sports-reception', 'library/facility/facility-sports-reception.jpg', 'image', 'facility', '{"facility","reception","desk","lobby"}', 1920, 1080, 'Modern sports complex front desk and welcoming reception', 'Quầy lễ tân đón tiếp hiện đại của trung tâm thể thao', 'Rishabh Malhotra', 'https://unsplash.com/photos/Rishabh-Malhotra', 'Unsplash License', '2026-10-17T13:10:34.826Z'),
  ('lib-facility-facility-weight-training-machines', 'library/facility/facility-weight-training-machines.jpg', 'image', 'facility', '{"facility","weight-training","machines","gym"}', 1920, 1080, 'Commercial multi-station cable machines in fitness center', 'Khu vực máy tập tạ khối đa năng trong trung tâm thể thao', 'Unsplash Contributor', 'https://unsplash.com/photos/weight-training-facility', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-other-sports-other-futsal-ball-step', 'library/other-sports/other-futsal-ball-step.jpg', 'image', 'other-sports', '{"futsal","ball","step","other-sports"}', 1920, 1080, 'Player foot resting on soccer ball before play', 'Chân vận động viên đặt trên quả bóng chuẩn bị thi đấu', 'Unsplash Contributor', 'https://unsplash.com/photos/soccer-ball-step', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-other-sports-other-futsal-ball-turf', 'library/other-sports/other-futsal-ball-turf.jpg', 'image', 'other-sports', '{"futsal","ball","turf","other-sports"}', 1920, 1080, 'Soccer ball and athletic cleat on artificial turf', 'Quả bóng đá và giày thi đấu trên sân cỏ nhân tạo', 'Unsplash Contributor', 'https://unsplash.com/photos/soccer-ball-turf', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-other-sports-other-futsal-indoor-match-contest', 'library/other-sports/other-futsal-indoor-match-contest.jpg', 'image', 'other-sports', '{"futsal","indoor","soccer","contest"}', 1920, 1080, 'Players contesting ball possession in indoor soccer match', 'Pha tranh chấp bóng kịch tính trong trận bóng đá futsal trong nhà', 'Alfonso Scarpa', 'https://unsplash.com/photos/two-men-playing-indoor-soccer-on-a-court-B5CoiKiHJ3U', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-other-sports-other-futsal-wooden-court-duel', 'library/other-sports/other-futsal-wooden-court-duel.jpg', 'image', 'other-sports', '{"futsal","indoor","wooden-court","duel"}', 1920, 1080, 'Two players competing in futsal match on indoor wooden court', 'Hai cầu thủ thi đấu futsal đối kháng trên sàn gỗ trong nhà', 'Alfonso Scarpa', 'https://unsplash.com/photos/two-men-playing-futsal-indoors-on-a-wooden-court-9ckhCcL3LuM', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-other-sports-other-pickleball-court-paddle-ball', 'library/other-sports/other-pickleball-court-paddle-ball.jpg', 'image', 'other-sports', '{"pickleball","paddle","ball","court"}', 1920, 1080, 'Pickleball paddle and bright green ball on textured court', 'Vợt pickleball và bóng xanh neon trên mặt sân nhám chuyên dụng', 'eedgar ivann', 'https://unsplash.com/photos/pickleball-paddle-and-ball-rest-on-the-court-zpy9Lh5aRgg', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-other-sports-other-pickleball-indoor-facility', 'library/other-sports/other-pickleball-indoor-facility.jpg', 'image', 'other-sports', '{"pickleball","indoor","facility","court"}', 1920, 1080, 'Player with pickleball paddle in modern indoor court facility', 'Vận động viên cầm vợt pickleball trong khu phức hợp sân trong nhà', 'Karl Joshua Bernal', 'https://unsplash.com/photos/woman-with-pickleball-paddle-in-court-HftNvT_UsGE', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-other-sports-other-pickleball-rally-match', 'library/other-sports/other-pickleball-rally-match.jpg', 'image', 'other-sports', '{"pickleball","match","rally","indoor"}', 1920, 1080, 'Players competing in pickleball match on indoor court', 'Pha bóng giao tranh kịch tính trên sân pickleball trong nhà', 'Karl Joshua Bernal', 'https://unsplash.com/photos/people-playing-pickleball-on-indoor-court-ZCToRox3q-g', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-other-sports-other-pickleball-social-play', 'library/other-sports/other-pickleball-social-play.jpg', 'image', 'other-sports', '{"pickleball","social","net","club"}', 1920, 1080, 'Athletes enjoying pickleball by the net in indoor sports club', 'Các thành viên giao lưu bên lưới pickleball sân trong nhà', 'Karl Joshua Bernal', 'https://unsplash.com/photos/adults-laughing-by-indoor-pickleball-net-HrNuH0UY61E', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-other-sports-other-table-tennis-blue-table', 'library/other-sports/other-table-tennis-blue-table.jpg', 'image', 'other-sports', '{"other-sports","table-tennis","paddle","table"}', 1920, 1080, 'Competition table tennis table and paddle ready for game', 'Bàn bóng bàn thi đấu và vợt chuẩn bị vào trận', 'Vladislav Babienko', 'https://unsplash.com/photos/Vladislav-Babienko', 'Unsplash License', '2026-10-17T13:10:34.826Z'),
  ('lib-other-sports-other-table-tennis-hall-doubles', 'library/other-sports/other-table-tennis-hall-doubles.jpg', 'image', 'other-sports', '{"table-tennis","doubles","hall","sports"}', 1920, 1080, 'Table tennis doubles game in indoor sports hall', 'Trận đấu bóng bàn đôi trên bàn xanh trong nhà thể thao', 'Alejandro Stuardo', 'https://unsplash.com/photos/women-playing-table-tennis-in-hall-7hRdtdDBWbU', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-other-sports-other-table-tennis-match-referee', 'library/other-sports/other-table-tennis-match-referee.jpg', 'image', 'other-sports', '{"table-tennis","match","referee","indoor"}', 1920, 1080, 'Table tennis competition match in indoor sports facility', 'Bốn người thi đấu bóng bàn trong nhà thi đấu có trọng tài', 'Alejandro Stuardo', 'https://unsplash.com/photos/table-tennis-match-with-referee-xbjtiXMaL4c', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-other-sports-other-table-tennis-net-setup', 'library/other-sports/other-table-tennis-net-setup.jpg', 'image', 'other-sports', '{"other-sports","table-tennis","net","ball"}', 1920, 1080, 'Table tennis net clamp and white celluloid ball', 'Cọc lưới bóng bàn và quả bóng trắng chuyên dụng', 'Mikhail Nilov', 'https://unsplash.com/photos/Mikhail-Nilov', 'Unsplash License', '2026-10-17T13:10:34.826Z'),
  ('lib-other-sports-other-tennis-ball-spin', 'library/other-sports/other-tennis-ball-spin.jpg', 'image', 'other-sports', '{"tennis","ball","spin","other-sports"}', 1920, 1080, 'Spinning yellow tennis ball with water droplets spray', 'Bóng tennis xoáy nước tuyệt đẹp trên nền tối', 'Unsplash Contributor', 'https://unsplash.com/photos/tennis-ball-spin', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-other-sports-other-tennis-court-indoor', 'library/other-sports/other-tennis-court-indoor.jpg', 'image', 'other-sports', '{"other-sports","tennis","court","hardcourt"}', 1920, 1080, 'Indoor hardcourt tennis court with pristine net', 'Sân quần vợt mặt sân cứng trong nhà tiêu chuẩn', 'Moises Alex', 'https://unsplash.com/photos/Moises-Alex', 'Unsplash License', '2026-10-17T13:10:34.826Z'),
  ('lib-other-sports-other-tennis-forehand-drive', 'library/other-sports/other-tennis-forehand-drive.jpg', 'image', 'other-sports', '{"tennis","forehand","racket","action"}', 1920, 1080, 'Player swinging tennis racket in powerful forehand stroke', 'Vận động viên vung vợt thực hiện cú thuận tay tennis mạnh mẽ', 'Dmitriy Ignatenko', 'https://unsplash.com/photos/a-man-is-swinging-a-tennis-racket-on-a-court-rl1XrMSfkAo', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-other-sports-other-tennis-net-court-view', 'library/other-sports/other-tennis-net-court-view.jpg', 'image', 'other-sports', '{"tennis","court","net","lines"}', 1920, 1080, 'Tennis court with net and boundary lines', 'Sân tennis với lưới ngăn tiêu chuẩn và vạch kẻ sân', 'Tim Chow', 'https://unsplash.com/photos/a-tennis-court-with-a-net-on-it-0PRyJ8acqbw', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-volleyball-volleyball-airborne-defense', 'library/volleyball/volleyball-airborne-defense.jpg', 'image', 'volleyball', '{"volleyball","airborne","defense","net"}', 1920, 1080, 'Volleyball players airborne at net defending attack', 'Pha bay người chắn bóng đỉnh cao trên không trung', 'daniil kazorin', 'https://unsplash.com/photos/volleyball-players-jumping-at-the-net-JsPEdQqhlVw', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-volleyball-volleyball-ball-on-court', 'library/volleyball/volleyball-ball-on-court.jpg', 'image', 'volleyball', '{"volleyball","ball","leather","court"}', 1920, 1080, 'Official leather volleyball resting beside court line', 'Quả bóng chuyền da chuyên dụng đặt cạnh vạch sân', 'Jeffrey F Lin', 'https://unsplash.com/photos/Jeffrey-F-Lin', 'Unsplash License', '2026-10-17T13:10:34.826Z'),
  ('lib-volleyball-volleyball-beach-sunset', 'library/volleyball/volleyball-beach-sunset.jpg', 'image', 'volleyball', '{"volleyball","sunset","spike","net"}', 1920, 1080, 'Volleyball players spiking over the net at sunset', 'Pha đập bóng chuyền qua lưới dưới ánh hoàng hôn', 'Unsplash Contributor', 'https://unsplash.com/photos/beach-volleyball-sunset', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-volleyball-volleyball-blocking-at-net', 'library/volleyball/volleyball-blocking-at-net.jpg', 'image', 'volleyball', '{"volleyball","block","net","indoor","match"}', 1920, 1080, 'Volleyball players jumping to block a ball at the net during match', 'Các vận động viên bóng chuyền bật cao chắn bóng trên lưới', 'daniil kazorin', 'https://unsplash.com/photos/volleyball-players-blocking-at-the-net-Ipcbpw4rrmw', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-volleyball-volleyball-cross-court-hit', 'library/volleyball/volleyball-cross-court-hit.jpg', 'image', 'volleyball', '{"volleyball","cross-court","spike","skill"}', 1920, 1080, 'Volleyball player spiking ball cross-court over net', 'Cú đập bóng chéo sân đầy kỹ thuật và chuẩn xác', 'daniil kazorin', 'https://unsplash.com/photos/volleyball-player-spiking-ball-over-net-fOM-3K8E88c', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-volleyball-volleyball-jump-serve-action', 'library/volleyball/volleyball-jump-serve-action.jpg', 'image', 'volleyball', '{"volleyball","serve","jump","power"}', 1920, 1080, 'Powerful jump serve execution in sports hall', 'Cú phát bóng tấn công uy lực trong nhà thi đấu', 'Vladislav Babienko', 'https://unsplash.com/photos/Vladislav-Babienko', 'Unsplash License', '2026-10-17T13:10:34.826Z'),
  ('lib-volleyball-volleyball-match-point-spike', 'library/volleyball/volleyball-match-point-spike.jpg', 'image', 'volleyball', '{"volleyball","match-point","spike","attack"}', 1920, 1080, 'Volleyball player jumping to spike decisive ball during match', 'Pha đập bóng uy lực ghi điểm quyết định trong trận đấu', 'daniil kazorin', 'https://unsplash.com/photos/volleyball-player-spiking-ball-during-match-UMzvVwp58qI', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-volleyball-volleyball-net-action-arena', 'library/volleyball/volleyball-net-action-arena.jpg', 'image', 'volleyball', '{"volleyball","arena","net","competing"}', 1920, 1080, 'Volleyball players in arena competing at the net', 'Vận động viên thi đấu tranh chấp bóng trên lưới tại nhà thi đấu', 'daniil kazorin', 'https://unsplash.com/photos/volleyball-players-competing-at-the-net-aKiQxdfhb4w', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-volleyball-volleyball-powerful-spike', 'library/volleyball/volleyball-powerful-spike.jpg', 'image', 'volleyball', '{"volleyball","spike","power","player"}', 1920, 1080, 'Volleyball player in blue jersey spiking ball over net', 'Tay đập bật cao tung cú đập bóng sấm sét qua lưới', 'daniil kazorin', 'https://unsplash.com/photos/volleyball-player-spiking-ball-in-match-m8BVr2zlYhg', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-volleyball-volleyball-spike-block-drill', 'library/volleyball/volleyball-spike-block-drill.jpg', 'image', 'volleyball', '{"volleyball","spike","block","duel"}', 1920, 1080, 'Spike and double block duel above the net', 'Pha đập bóng đối đầu hàng chắn đôi trên lưới', 'Andrew Stutesman', 'https://unsplash.com/photos/Andrew-Stutesman', 'Unsplash License', '2026-10-17T13:10:34.826Z'),
  ('lib-volleyball-volleyball-spike-vs-double-block', 'library/volleyball/volleyball-spike-vs-double-block.jpg', 'image', 'volleyball', '{"volleyball","spike","blockers","action"}', 1920, 1080, 'Volleyball player spiking ball over net against two jumping blockers', 'Vận động viên bật đập bóng qua hàng chắn đôi trên lưới', 'daniil kazorin', 'https://unsplash.com/photos/volleyball-players-spiking-and-blocking-7pxQ66sDr5s', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('lib-volleyball-volleyball-two-man-block', 'library/volleyball/volleyball-two-man-block.jpg', 'image', 'volleyball', '{"volleyball","defense","block","teamwork"}', 1920, 1080, 'Two volleyball players in blue jerseys forming defensive block', 'Hai tay chắn phối hợp dựng bức tường phòng ngự trên lưới', 'daniil kazorin', 'https://unsplash.com/photos/volleyball-players-blocking-at-net-SJ5Ofc_sOGM', 'Unsplash License', '2026-10-17T15:05:54.034Z'),
  ('legacy-lounge', 'lounge.jpg', 'image', 'legacy', '{"legacy","lounge"}', 1280, 720, 'Arena3 site asset: lounge', 'Tài nguyên Arena3: lounge', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-member-card', 'member-card.jpg', 'image', 'legacy', '{"legacy","member-card"}', 1280, 720, 'Arena3 site asset: member-card', 'Tài nguyên Arena3: member-card', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-racket', 'racket.jpg', 'image', 'legacy', '{"legacy","racket"}', 1280, 720, 'Arena3 site asset: racket', 'Tài nguyên Arena3: racket', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-reception-still', 'reception-still.jpg', 'image', 'legacy', '{"legacy","reception-still"}', 1280, 720, 'Arena3 site asset: reception-still', 'Tài nguyên Arena3: reception-still', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-reception', 'reception.jpg', 'image', 'legacy', '{"legacy","reception"}', 1280, 720, 'Arena3 site asset: reception', 'Tài nguyên Arena3: reception', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-reception', 'reception.mp4', 'video', 'legacy', '{"legacy","reception"}', 1920, 1080, 'Arena3 site asset: reception', 'Tài nguyên Arena3: reception', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-smash', 'smash.mp4', 'video', 'legacy', '{"legacy","smash"}', 1920, 1080, 'Arena3 site asset: smash', 'Tài nguyên Arena3: smash', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-train-progress', 'train-progress.jpg', 'image', 'legacy', '{"legacy","train-progress"}', 1280, 720, 'Arena3 site asset: train-progress', 'Tài nguyên Arena3: train-progress', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-volleyball-action', 'volleyball-action.jpg', 'image', 'legacy', '{"legacy","volleyball-action"}', 1280, 720, 'Arena3 site asset: volleyball-action', 'Tài nguyên Arena3: volleyball-action', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-volleyball', 'volleyball.jpg', 'image', 'legacy', '{"legacy","volleyball"}', 1280, 720, 'Arena3 site asset: volleyball', 'Tài nguyên Arena3: volleyball', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z'),
  ('legacy-wellness', 'wellness.jpg', 'image', 'legacy', '{"legacy","wellness"}', 1280, 720, 'Arena3 site asset: wellness', 'Tài nguyên Arena3: wellness', 'Arena3 Studio', 'https://arena3.vn', 'project', '2026-10-16T07:58:30.214Z')
ON CONFLICT (id) DO NOTHING;

-- Upgrade seeded coach assets to verified high-resolution portraits
UPDATE site_assets
   SET src_path = '/media/library/coach/coach-nguyen-minh-khoa.jpg',
       default_path = '/media/library/coach/coach-nguyen-minh-khoa.jpg'
 WHERE slot = 'coach.00000000-0000-0000-0000-000000000011'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/coach/coach-tran-thi-lan.jpg',
       default_path = '/media/library/coach/coach-tran-thi-lan.jpg'
 WHERE slot = 'coach.00000000-0000-0000-0000-000000000012'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/coach/coach-pham-duc-anh.jpg',
       default_path = '/media/library/coach/coach-pham-duc-anh.jpg'
 WHERE slot = 'coach.00000000-0000-0000-0000-000000000013'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/coach/coach-le-quoc-viet.jpg',
       default_path = '/media/library/coach/coach-le-quoc-viet.jpg'
 WHERE slot = 'coach.00000000-0000-0000-0000-000000000014'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/coach/coach-minh-quan.jpg',
       default_path = '/media/library/coach/coach-minh-quan.jpg'
 WHERE slot = 'coach.00000000-0000-0000-0000-000000000003'
   AND bytes IS NULL
   AND src_path = default_path;

-- Upgrade existing general site slots to verified curated high-resolution library images
UPDATE site_assets
   SET src_path = '/media/library/facility/facility-multi-court-arena-view.jpg',
       default_path = '/media/library/facility/facility-multi-court-arena-view.jpg'
 WHERE slot = 'landing.hero.image'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/badminton/badminton-indoor-court-wide.jpg',
       default_path = '/media/library/badminton/badminton-indoor-court-wide.jpg'
 WHERE slot = 'landing.courts.badminton'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/basketball/basketball-court-hardwood.jpg',
       default_path = '/media/library/basketball/basketball-court-hardwood.jpg'
 WHERE slot = 'landing.courts.basketball'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/volleyball/volleyball-net-action-arena.jpg',
       default_path = '/media/library/volleyball/volleyball-net-action-arena.jpg'
 WHERE slot = 'landing.courts.volleyball'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/badminton/badminton-racket-frame-view.jpg',
       default_path = '/media/library/badminton/badminton-racket-frame-view.jpg'
 WHERE slot = 'landing.facilities.badminton'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/basketball/basketball-practice-hall.jpg',
       default_path = '/media/library/basketball/basketball-practice-hall.jpg'
 WHERE slot = 'landing.facilities.basketball'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/volleyball/volleyball-spike-block-drill.jpg',
       default_path = '/media/library/volleyball/volleyball-spike-block-drill.jpg'
 WHERE slot = 'landing.facilities.volleyball'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/facility/facility-sports-reception.jpg',
       default_path = '/media/library/facility/facility-sports-reception.jpg'
 WHERE slot = 'landing.facilities.reception'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/facility/facility-hardwood-gym-hall.jpg',
       default_path = '/media/library/facility/facility-hardwood-gym-hall.jpg'
 WHERE slot = 'landing.facilities.hall'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/facility/facility-arena-grandstand-hall.jpg',
       default_path = '/media/library/facility/facility-arena-grandstand-hall.jpg'
 WHERE slot = 'landing.closing'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/facility/facility-arena-grandstand-hall.jpg',
       default_path = '/media/library/facility/facility-arena-grandstand-hall.jpg'
 WHERE slot = 'auth.login.image'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/coach/coach-young-athlete-trainer.jpg',
       default_path = '/media/library/coach/coach-young-athlete-trainer.jpg'
 WHERE slot = 'auth.register.image'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/badminton/badminton-indoor-court-wide.jpg',
       default_path = '/media/library/badminton/badminton-indoor-court-wide.jpg'
 WHERE slot = 'sport.badminton'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/basketball/basketball-indoor-wooden-court.jpg',
       default_path = '/media/library/basketball/basketball-indoor-wooden-court.jpg'
 WHERE slot = 'sport.basketball'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/volleyball/volleyball-net-action-arena.jpg',
       default_path = '/media/library/volleyball/volleyball-net-action-arena.jpg'
 WHERE slot = 'sport.volleyball'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/facility/facility-multi-court-arena-view.jpg',
       default_path = '/media/library/facility/facility-multi-court-arena-view.jpg'
 WHERE slot = 'sport.all'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/facility/facility-multi-court-arena-view.jpg',
       default_path = '/media/library/facility/facility-multi-court-arena-view.jpg'
 WHERE slot = 'banner.book'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/class/class-functional-agility-class.jpg',
       default_path = '/media/library/class/class-functional-agility-class.jpg'
 WHERE slot = 'banner.classes'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/class/class-movement-drills.jpg',
       default_path = '/media/library/class/class-movement-drills.jpg'
 WHERE slot = 'banner.train'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/class/class-team-conditioning.jpg',
       default_path = '/media/library/class/class-team-conditioning.jpg'
 WHERE slot = 'banner.coach'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/facility/facility-sports-reception.jpg',
       default_path = '/media/library/facility/facility-sports-reception.jpg'
 WHERE slot = 'banner.gate'
   AND bytes IS NULL
   AND src_path = default_path;

UPDATE site_assets
   SET src_path = '/media/library/facility/facility-hardwood-gym-hall.jpg',
       default_path = '/media/library/facility/facility-hardwood-gym-hall.jpg'
 WHERE slot = 'banner.manager'
   AND bytes IS NULL
   AND src_path = default_path;

-- Add missing slots for plan, class, empty state, and gallery with curated photography
INSERT INTO site_assets (slot, kind, src_path, default_path, alt_en, alt_vi) VALUES
  ('plan.default', 'image', '/media/library/event/event-championship-sports-hall.jpg', '/media/library/event/event-championship-sports-hall.jpg', 'Membership plan card', 'Thẻ gói tập hội viên'),
  ('class.default', 'image', '/media/library/class/class-functional-agility-class.jpg', '/media/library/class/class-functional-agility-class.jpg', 'Training class session', 'Lớp học đào tạo kỹ năng'),
  ('empty.default', 'image', '/media/library/badminton/badminton-empty-courts-hall.jpg', '/media/library/badminton/badminton-empty-courts-hall.jpg', 'Empty state illustration', 'Hình nền trạng thái trống'),
  ('landing.gallery.1', 'image', '/media/library/badminton/badminton-shuttlecock-on-net.jpg', '/media/library/badminton/badminton-shuttlecock-on-net.jpg', 'Badminton in action', 'Pha cầu lông kịch tính'),
  ('landing.gallery.2', 'image', '/media/library/basketball/basketball-jump-shot-drive.jpg', '/media/library/basketball/basketball-jump-shot-drive.jpg', 'Basketball jump shot', 'Cú ném bóng rổ'),
  ('landing.gallery.3', 'image', '/media/library/volleyball/volleyball-powerful-spike.jpg', '/media/library/volleyball/volleyball-powerful-spike.jpg', 'Volleyball block', 'Pha chắn bóng chuyền'),
  ('landing.gallery.4', 'image', '/media/library/facility/facility-hardwood-gym-hall.jpg', '/media/library/facility/facility-hardwood-gym-hall.jpg', 'Competition courts', 'Mặt sân thi đấu'),
  ('landing.gallery.5', 'image', '/media/library/facility/facility-sports-reception.jpg', '/media/library/facility/facility-sports-reception.jpg', 'Friendly reception', 'Lễ tân tiếp đón'),
  ('landing.gallery.6', 'image', '/media/library/equipment/equipment-1-shuttlecocks-yonex-aerosensa-20.jpg', '/media/library/equipment/equipment-1-shuttlecocks-yonex-aerosensa-20.jpg', 'Floor texture detail', 'Chi tiết vân sàn chuyên dụng'),
  ('landing.gallery.7', 'image', '/media/library/facility/facility-fitness-studio.jpg', '/media/library/facility/facility-fitness-studio.jpg', 'Player lounge area', 'Khu nghỉ ngơi vận động viên'),
  ('landing.gallery.8', 'image', '/media/library/facility/facility-arena-exterior-entrance.jpg', '/media/library/facility/facility-arena-exterior-entrance.jpg', 'Arena3 frontage', 'Mặt tiền trung tâm')
ON CONFLICT (slot) DO NOTHING;
