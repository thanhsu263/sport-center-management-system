import os
import sys
import win32com.client

def convert_docx_to_pdf():
    docx_path = os.path.abspath(r"docs/Arena3-SRS.docx")
    pdf_path = os.path.abspath(r"docs/Arena3-SRS.pdf")
    pdf_temp = os.path.abspath(r"docs/Arena3-SRS-v1.7.pdf")

    print(f"Opening Word to convert:\n  Source: {docx_path}\n  Target: {pdf_path}")

    word = win32com.client.Dispatch("Word.Application")
    word.Visible = False
    word.DisplayAlerts = False

    try:
        doc = word.Documents.Open(docx_path, ReadOnly=True)
        # Update fields (e.g. Table of Contents, Page numbers)
        try:
            print("Updating document fields and page numbers...")
            doc.Fields.Update()
        except Exception as e:
            print("Note on field update:", e)

        # 17 represents wdFormatPDF
        print("Saving as PDF...")
        doc.SaveAs(pdf_path, FileFormat=17)
        # Also save a copy with version name
        doc.SaveAs(pdf_temp, FileFormat=17)
        doc.Close(False)
        print("Successfully exported to PDF!")
    except Exception as err:
        print("Error during Word conversion:", err)
        sys.exit(1)
    finally:
        word.Quit()

if __name__ == "__main__":
    convert_docx_to_pdf()
