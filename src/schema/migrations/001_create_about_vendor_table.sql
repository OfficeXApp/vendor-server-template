CREATE TABLE IF NOT EXISTS about_vendor (
    id TEXT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    version VARCHAR(50) NOT NULL
);

-- Insert the initial vendor information
INSERT INTO about_vendor (id, name, version)
VALUES ('about_vendor', 'Vendor', '0.0.1')
ON CONFLICT (id) DO NOTHING;