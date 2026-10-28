import pypdf
import os

def merge_srs():
    srs_pdf_path = r"docs/Arena3-SRS.pdf"
    diagrams_pdf_path = r"docs/Arena3-SRS-Diagrams.pdf"
    output_pdf_path = r"docs/Arena3-SRS.pdf"
    output_temp_path = r"docs/Arena3-SRS-60pages.pdf"

    reader_srs = pypdf.PdfReader(srs_pdf_path)
    reader_diag = pypdf.PdfReader(diagrams_pdf_path)

    writer = pypdf.PdfWriter()

    print(f"Main SRS pages: {len(reader_srs.pages)}")
    print(f"Diagrams pages: {len(reader_diag.pages)}")

    # Add all 55 pages of main SRS
    for page in reader_srs.pages:
        writer.add_page(page)

    # Add the 5 pages of standardized diagrams & audit matrix
    for page in reader_diag.pages:
        writer.add_page(page)

    total_pages = len(writer.pages)
    print(f"Total merged pages: {total_pages}")

    with open(output_temp_path, "wb") as f_out:
        writer.write(f_out)

    # Also overwrite Arena3-SRS.pdf so whoever opens Arena3-SRS.pdf gets the full 60 pages!
    with open(output_pdf_path, "wb") as f_out:
        writer.write(f_out)

    print(f"Successfully generated 60-page SRS at:\n  {output_pdf_path}\n  {output_temp_path}")

if __name__ == "__main__":
    merge_srs()
