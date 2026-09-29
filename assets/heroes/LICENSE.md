# [HERO] assets/heroes — модели и анимации героев (CC0 1.0)

| Файл | Что | Источник | Лицензия |
|---|---|---|---|
| `knight.glb` | Пепельный страж: мужское тело + латы Knight (шлем Armet, наплечники) | **Quaternius** — Modular Character Outfits (Fantasy) / Universal Base Characters; части собраны в один GLB (скелет UAL, 65 костей, текстуры 512² с картами ORM). Копия исходников: https://raw.githubusercontent.com/kirbycope/godot-npc-village/HEAD/assets/quaternius/ и репозиторий dustinc555/mygame | CC0 1.0 (`License_Source.txt` Quaternius: https://raw.githubusercontent.com/kirbycope/godot-npc-village/HEAD/assets/quaternius/License_Source.txt) |
| `wizard.glb` | Архимаг: мужское тело, голова, волосы, борода + мантия Wizard | то же | CC0 1.0 |
| `ranger.glb` | Лучница: женское тело + костюм Ranger с капюшоном | то же (бесплатная часть набора) | CC0 1.0 |
| `anims_kaykit.glb` | 35 клипов без мешей (скелет KayKit): стрейфы, шаг назад, рывки, касты, лук, блок, удары, победа | **Kay Lousberg / KayKit** — Adventurers Character Pack 1.0, `Mage.glb`, https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0 ; меши и текстуры убраны `tools/strip_anims.py` | CC0 1.0 (LICENSE.txt репозитория) |

Автор моделей Quaternius (https://quaternius.com), анимаций — Kay Lousberg (https://kaylousberg.com).
Указание автора по CC0 не обязательно, но мы его оставляем.
Клипы переносятся на героев в браузере (`modules/vrmKit.js`: retargetClip, loadHumanoidGLB).
