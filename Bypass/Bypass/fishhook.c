// fishhook.c
// Implementation of fishhook symbol rebinding

#include "fishhook.h"

#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <mach-o/dyld.h>
#include <mach-o/loader.h>
#include <mach-o/nlist.h>

#ifdef __LP64__
typedef struct mach_header_64 mach_header_t;
typedef struct segment_command_64 segment_command_t;
typedef struct section_64 section_t;
typedef struct nlist_64 nlist_t;
#define LC_SEGMENT_ARCH_DEPENDENT LC_SEGMENT_64
#else
typedef struct mach_header mach_header_t;
typedef struct segment_command segment_command_t;
typedef struct section section_t;
typedef struct nlist nlist_t;
#define LC_SEGMENT_ARCH_DEPENDENT LC_SEGMENT
#endif

static void perform_rebinding_with_section(struct rebinding rebindings[],
                                           size_t rebindings_nel,
                                           section_t *section,
                                           intptr_t slide,
                                           nlist_t *symtab,
                                           char *strtab,
                                           uint32_t *indirect_symtab) {
    uint32_t *indirect_symbol_indices = indirect_symtab + section->reserved1;
    void **indirect_symbol_bindings = (void **)((uintptr_t)slide + section->addr);
    
    for (uint i = 0; i < section->size / sizeof(void *); i++) {
        uint32_t symtab_index = indirect_symbol_indices[i];
        if (symtab_index == INDIRECT_SYMBOL_ABS || symtab_index == INDIRECT_SYMBOL_LOCAL ||
            symtab_index == (INDIRECT_SYMBOL_LOCAL | INDIRECT_SYMBOL_ABS)) {
            continue;
        }
        uint32_t strtab_offset = symtab[symtab_index].n_un.n_strx;
        char *symbol_name = strtab + strtab_offset;
        
        for (uint j = 0; j < rebindings_nel; j++) {
            if (strcmp(&symbol_name[1], rebindings[j].name) == 0) {
                if (rebindings[j].replaced != NULL && indirect_symbol_bindings[i] != rebindings[j].replacement) {
                    *(rebindings[j].replaced) = indirect_symbol_bindings[i];
                }
                indirect_symbol_bindings[i] = rebindings[j].replacement;
                goto symbol_loop;
            }
        }
    symbol_loop:;
    }
}

static void rebind_symbols_for_image(struct rebinding rebindings[],
                                     size_t rebindings_nel,
                                     const struct mach_header *header,
                                     intptr_t slide) {
    Dl_info info;
    if (dladdr(header, &info) == 0) {
        return;
    }
    
    segment_command_t *cur_seg_cmd;
    segment_command_t *linkedit_segment = NULL;
    struct symtab_command *symtab_cmd = NULL;
    struct dysymtab_command *dysymtab_cmd = NULL;
    
    uintptr_t cur = (uintptr_t)header + sizeof(mach_header_t);
    for (uint i = 0; i < header->ncmds; i++, cur += cur_seg_cmd->cmdsize) {
        cur_seg_cmd = (segment_command_t *)cur;
        if (cur_seg_cmd->cmd == LC_SEGMENT_ARCH_DEPENDENT) {
            if (strcmp(cur_seg_cmd->segname, SEG_LINKEDIT) == 0) {
                linkedit_segment = cur_seg_cmd;
            }
        } else if (cur_seg_cmd->cmd == LC_SYMTAB) {
            symtab_cmd = (struct symtab_command *)cur_seg_cmd;
        } else if (cur_seg_cmd->cmd == LC_DYSYMTAB) {
            dysymtab_cmd = (struct dysymtab_command *)cur_seg_cmd;
        }
    }
    
    if (!symtab_cmd || !dysymtab_cmd || !linkedit_segment) {
        return;
    }
    
    uintptr_t linkedit_base = (uintptr_t)slide + linkedit_segment->vmaddr - linkedit_segment->fileoff;
    nlist_t *symtab = (nlist_t *)(linkedit_base + symtab_cmd->symoff);
    char *strtab = (char *)(linkedit_base + symtab_cmd->stroff);
    uint32_t *indirect_symtab = (uint32_t *)(linkedit_base + dysymtab_cmd->indirectsymoff);
    
    cur = (uintptr_t)header + sizeof(mach_header_t);
    for (uint i = 0; i < header->ncmds; i++, cur += cur_seg_cmd->cmdsize) {
        cur_seg_cmd = (segment_command_t *)cur;
        if (cur_seg_cmd->cmd == LC_SEGMENT_ARCH_DEPENDENT) {
            section_t *sections = (section_t *)(cur_seg_cmd + 1);
            for (uint j = 0; j < cur_seg_cmd->nsects; j++) {
                if ((sections[j].flags & SECTION_TYPE) == S_LAZY_SYMBOL_POINTERS ||
                    (sections[j].flags & SECTION_TYPE) == S_NON_LAZY_SYMBOL_POINTERS) {
                    perform_rebinding_with_section(rebindings, rebindings_nel, &sections[j],
                                                   slide, symtab, strtab, indirect_symtab);
                }
            }
        }
    }
}

int rebind_symbols(struct rebinding rebindings[], size_t rebindings_nel) {
    int retval = 0;
    for (uint32_t i = 0; i < _dyld_image_count(); i++) {
        rebind_symbols_for_image(rebindings, rebindings_nel,
                                _dyld_get_image_header(i),
                                _dyld_get_image_vmaddr_slide(i));
    }
    return retval;
}
