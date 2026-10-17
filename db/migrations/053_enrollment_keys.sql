ALTER TABLE mobile_installations ADD COLUMN public_key_jwk jsonb;
ALTER TABLE capture_enrollment_challenges ADD COLUMN platform text NOT NULL DEFAULT 'ios' CHECK(platform IN ('ios','android'));
ALTER TABLE capture_enrollment_challenges ADD COLUMN public_key_jwk jsonb;
